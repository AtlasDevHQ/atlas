/**
 * Shared corpus for the two halves of the identity pairing (#5019, ADR-0037).
 *
 * `identity.test.ts` pins what the TypeScript does; `identity-pg.test.ts` runs
 * the real migration and compares. Those are two implementations of one
 * function, so the inputs have to be ONE list — two hand-written lists of "what
 * counts as degenerate" drift, and an entry present in only one of them is
 * pinned on one implementation and never cross-checked against the other, which
 * is exactly the property the pairing exists to test.
 *
 * Not a `.test.ts`, so the isolated runner does not try to execute it.
 */

/**
 * Surfaces whose lexical norm is the empty string.
 *
 * `lexicalNorm` returns `""` for each; `identityKey` must return `null`, and
 * migration 0187's `NULLIF(…, '')` must agree. A stored `""` would put every
 * one of these in a single slot — the `DEFAULT ''` hazard the migration header
 * rejects, reached from the other side.
 */
export const DEGENERATE_SURFACES = ["", "-", "___", "  ", " - _ ", "--__--"] as const;

/**
 * The surfaces whose behaviour is a CROSS-IMPLEMENTATION claim — each one is
 * asserted by `identity.test.ts` against the TypeScript and by
 * `identity-pg.test.ts` against migration 0187's SQL.
 *
 * These are the entries where duplication actually costs something. Dropping
 * `ΣΊΣΥΦΟΣ` from the pg corpus while it stayed inline in the unit test would
 * leave the ASCII-fold decision pinned on one implementation with both files
 * green — which is the failure this module was created to prevent, applied to
 * the entries that matter most.
 */
export const PAIRED_SURFACES = {
  /** Live in the corpus and INVERSE relations — they must never collapse. */
  inverseRelations: ["led_by", "leads"] as const,
  /** #5000's pair: normalizing these together is a vocabulary entry's job. */
  copulaPair: ["is priced at", "priced at"] as const,
  /**
   * Where `lower()` and `String#toLowerCase()` measurably disagree, which is
   * why the fold is ASCII-only. Restoring `lower()` on either side fails.
   */
  caseFold: ["İstanbul", "ΣΊΣΥΦΟΣ", "CAFÉ", "МОСКВА"] as const,
  /**
   * U+00A0 is NOT a separator — the load-bearing consequence of spelling the
   * separator class out instead of writing `\s` or `[[:space:]]`.
   */
  nonAsciiSpace: ["owned\u00a0by"] as const,
  /** Every uppercase letter, so a typo in 0187's hand-typed pair cannot hide. */
  alphabet: ["ABCDEFGHIJKLMNOPQRSTUVWXYZ", "GHIJKL-QVXZ_ghijkl"] as const,
} as const;

/** Every paired surface, flattened — the pg corpus consumes this. */
export const ALL_PAIRED_SURFACES = Object.values(PAIRED_SURFACES).flat();
