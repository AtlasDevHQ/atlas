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
