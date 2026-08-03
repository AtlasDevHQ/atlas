/**
 * Claim identity — the lexical layer (ADR-0037 §"The identity key", #5019).
 *
 * A brain claim's identity key is two layers over the retained surface form:
 *
 *   key = alias( lexicalNorm( surface ) )
 *
 * This module owns the INNER one. `alias` — the curated, versioned workspace
 * vocabulary — is a later slice, and until it exists it is the identity
 * function, so every key produced today is exactly {@link identityKey} of the
 * surface: `lexicalNorm(surface)`, or `null` where that is empty. That is why
 * this slice is expected to change no observable behaviour at all.
 *
 * ## What `lexicalNorm` is, and the harder question of what it is NOT
 *
 * Case-fold, unify separators, trim, collapse runs. **Nothing else.** No
 * stemming, no lemmatisation, no copula- or stopword-stripping, and this is a
 * refusal rather than an omission: the live corpus carries `led_by` AND `leads`,
 * which are INVERSE relations (`X led_by Y` ⇄ `Y leads X`, subject and object
 * swapped). Any stemmer collapses them into one slot, and the slot is a JOIN
 * arm — so publishing "Alice leads Platform" would stamp `valid_to` on
 * "Platform led_by Alice". Under-matching two spellings of one predicate costs
 * a missed corroboration and a missed tension edge, both recoverable; over-
 * matching two DIFFERENT predicates costs an irreversible supersession stamp.
 * The layer is deliberately dumb because the recoverable direction is the only
 * one it is allowed to be wrong in.
 *
 * The consequence, stated because it looks like a gap: `is priced at` and
 * `priced at` do NOT normalize together here, and they are not supposed to. The
 * fix for that pair is a vocabulary ENTRY with a reviewer behind it — the same
 * rule applied generally would collapse `is owned by` into `owns`.
 *
 * ## Determinism, and why the character classes are spelled out
 *
 * Pure, total, offline: no model, no network, no clock, no randomness, no
 * locale — ADR-0037 §1's own words. The only input is the string. That is
 * load-bearing rather than tidy, for one concrete reason: the day-one backfill
 * (migration 0187) is a SECOND implementation of this function, written in SQL,
 * and two implementations that disagree on any input are two functions.
 *
 * (Not for a re-derive-on-import reason — ADR-0037 §8 settles that a row-copy
 * path carries keys VERBATIM and never re-derives, precisely because
 * re-deriving fails to over-match, which is the irreversible direction.)
 *
 * So the separator set is written out — `[ \t\n\v\f\r_-]` — rather than as
 * `\s` or `[[:space:]]`. Those two classes are NOT the same set: JavaScript's
 * `\s` includes U+00A0 and the U+2000 block, while Postgres's `[[:space:]]`
 * consults the database locale for anything above ASCII. Spelling the set means
 * the two implementations agree by construction instead of by coincidence of
 * collation. A non-breaking space therefore survives INTO the key as an
 * ordinary character — an under-match on a surface no producer in this repo
 * emits, which is the safe direction.
 *
 * ## The case fold is ASCII-only, and that is a measured decision
 *
 * `String#toLowerCase()` and Postgres's `lower()` DO NOT AGREE, and the gap is
 * not theoretical — it was measured against this repo's `postgres:16-alpine`
 * while writing this module:
 *
 *   - `İstanbul` (U+0130) → `lower()` drops the dot and yields `istanbul`;
 *     JavaScript applies the Unicode special-casing rule and yields `i` +
 *     U+0307.
 *   - `ΣΊΣΥΦΟΣ` → JavaScript is context-sensitive and lowers the WORD-FINAL
 *     sigma to `ς`; `lower()` yields `σ` in both positions.
 *
 * Postgres's own answer is collation-dependent on top of that, so a key would
 * depend on WHERE it was computed — which is what §1's "pure, total,
 * vocabulary-free, offline" rules out. So the fold is `A`–`Z` only, in both
 * implementations, and every character above ASCII passes through unchanged.
 *
 * The cost is real and worth stating: `Café` and `CAFÉ` do not norm together,
 * nor do `МОСКВА` and `москва`. That is an UNDER-match — a duplicate row, a
 * missed corroboration, a missed tension edge, all recoverable, and all
 * strictly better than the byte-exact identity this replaces. A specific pair
 * that matters is repaired by a vocabulary entry with a reviewer behind it. The
 * alternative — a fold that varies with the database's collation — trades that
 * for keys two regions compute differently, which no reviewer can see.
 *
 * `identity-pg.test.ts` carries both counter-examples above in its corpus and
 * compares the real migration to this function row by row, so restoring
 * `lower()` on either side fails CI rather than silently keying rows nothing
 * will ever join.
 */

/**
 * Separator run → one space. `-` sits LAST so the bracket reads it as a literal
 * rather than opening a range; migration 0187's twin does the same.
 */
const SEPARATOR_RUN = /[ \t\n\v\f\r_-]+/g;

// The `/g` flags above and below are for `String#replace`, which resets
// `lastIndex` on every call. Do not reach for `.test()` or `.exec()` on these —
// those DO carry state across calls, and a stateful matcher on a function whose
// whole contract is determinism is a footgun worth naming.

/** Leading/trailing space, after the collapse above has left at most one each. */
const EDGE_SPACE = /^ +| +$/g;

/**
 * The case fold — `A`–`Z` and nothing else, mirroring 0187's `translate()`.
 * Restricted to the range where `toLowerCase()` is a pure `+0x20` and therefore
 * cannot disagree with Postgres; see the header for the two characters that
 * proved the unrestricted form does.
 */
const ASCII_UPPER = /[A-Z]/g;
const foldAscii = (c: string): string => String.fromCharCode(c.charCodeAt(0) + 32);

/**
 * The lexical layer of a claim's identity key.
 *
 * TOTAL — every string has a norm, including the empty one. Totality is not a
 * convenience: the vocabulary's forest invariant rests on `f(f(x)) === f(x)`,
 * and a partial function has no fixpoint to reason about. A surface made only
 * of separators norms to `""`.
 *
 * `""` is a norm. It is NOT a key — see {@link identityKey}.
 */
export function lexicalNorm(surface: string): string {
  return surface
    .replace(ASCII_UPPER, foldAscii)
    .replace(SEPARATOR_RUN, " ")
    .replace(EDGE_SPACE, "");
}

/**
 * The stored identity key: the norm, or `null` when the norm is empty.
 *
 * ## Why the empty norm must not be stored
 *
 * Migration 0187's header rejects a `DEFAULT ''` on these columns because
 * "every unkeyed row joins every other unkeyed row". `lexicalNorm` reaches that
 * same value by a different road — `"___"`, `"-"`, `"  "` all norm to `""` —
 * and the ingest guard does not stop them: `reconcile.ts`'s `MALFORMED_CLAIM`
 * test is `surface.trim() === ""`, and `String#trim` strips whitespace but not
 * `_` or `-`. So a producer emitting `-` for a missing value lands a storable
 * claim today, and under a stored `""` key every such claim would occupy ONE
 * slot: two unrelated placeholder facts corroborate as one, and at `single`
 * cardinality publishing either stamps `valid_to` on the other.
 *
 * That is the module's own forbidden direction — an over-match at a join arm,
 * reached from the one input class the lexical layer cannot distinguish. `null`
 * joins nothing, which is the honest answer for a surface that asserts nothing.
 *
 * ⚠️ It does OVERLOAD the column, though, and the overload has a consequence
 * worth carrying forward: a NULL key now means either "no writer has keyed this
 * row yet" (transient) or "this surface norms away" (permanent, and legal). So
 * `SET NOT NULL` cannot land on the keys until `reconcile.ts`'s
 * `MALFORMED_CLAIM` guard also refuses a candidate whose `identityKey` is null
 * — otherwise the constraint turns a claim that is storable today into a
 * transaction-killing not-null violation. Migration 0187's header records this
 * as the third prerequisite; no issue owns it yet.
 *
 * Migration 0187 mirrors this with `NULLIF(…, '')`; the two are pinned against
 * each other row by row in `identity-pg.test.ts`.
 *
 * Kept SEPARATE from `lexicalNorm` rather than folded into it, because the two
 * answer different questions: `lexicalNorm` is the pure normalization the
 * vocabulary composes over (and must stay total to have a fixpoint), while this
 * is the storage decision. #5020 calls this one at the INSERT site.
 */
export function identityKey(surface: string): string | null {
  const norm = lexicalNorm(surface);
  return norm === "" ? null : norm;
}
