/**
 * Claim identity — the lexical layer (ADR-0037 §"The identity key", #5019).
 *
 * A brain claim's identity key is two layers over the retained surface form:
 *
 *   key = alias( lexicalNorm( surface ) )
 *
 * This module owns the INNER one, and since #5020 it also owns the composition
 * ({@link slotKey}). `alias` — the curated workspace vocabulary (ADR-0037 §6 /
 * #5016) — is a data table since #5022, and lives in `lib/brain/vocabulary.ts`;
 * this module keeps only its TYPE ({@link ClaimVocabulary}) and its empty case
 * ({@link identityVocabulary}), so the pure lexical layer has no database
 * dependency and the composition stays in one place.
 *
 * A workspace that has approved no alias still keys exactly {@link identityKey}
 * of the surface — `lexicalNorm(surface)`, or `null` where that is empty.
 *
 * That made #5019 — the columns and the backfill — a slice with no observable
 * behaviour at all. It does NOT make #5020 one: materializing these keys and
 * pivoting the three slot consumers onto them is exactly what turns two
 * spellings of a claim into one, and `reconcile.ts`'s header owns that
 * consequence.
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

import type { ExportedVocabularySlotPosition } from "@useatlas/types";

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
 * convenience: the vocabulary composes over this function and relies on
 * `f(f(x)) === f(x)` (ADR-0037 §6, and {@link slotKey}, which re-norms the
 * vocabulary's answer on the strength of it), and a partial function has no
 * fixpoint to reason about. A surface made only of separators norms to `""`.
 * (An earlier version of this line called that a "forest invariant" — §6
 * retracts T3's forest framing by name, and the ADR lists it again under
 * "Corrections to the record".)
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
 * is the storage decision. {@link slotKey} is what #5020 calls at the INSERT
 * site; this is its vocabulary-free half.
 */
export function identityKey(surface: string): string | null {
  const norm = lexicalNorm(surface);
  return norm === "" ? null : norm;
}

/**
 * The OUTER layer of `key = alias(lexicalNorm(surface))` — the curated
 * workspace vocabulary at ONE claim slot, as a seam.
 *
 * Backed by data since #5022: `lib/brain/vocabulary.ts` builds one of these per
 * position out of `brain_vocabulary_target`, the transitive closure of the
 * workspace's approved alias edges. {@link identityAlias} remains the empty
 * vocabulary — the answer for a workspace that has approved nothing, and the
 * one every non-ingest call site names out loud.
 *
 * The seam predated its data (#5020) for the same reason `reconcile.ts`'s
 * `EntityResolver` seam predates any entity store: what that slice pinned is
 * the SHAPE — a norm goes in, a norm comes out, and the composition happens in
 * ONE place. What it could not pin is that a vocabulary is POSITION-scoped, so
 * #5022 wrapped three of these in {@link ClaimVocabulary} rather than leaving a
 * bare lookup on the request. See there for why that is a correctness
 * requirement and not a tidier signature.
 *
 * Takes the NORM, not the surface: the vocabulary maps normalized spellings to
 * a chosen one (`is priced at` → `priced at`), so a lookup keyed on raw surfaces
 * would need an entry per casing and separator variant of both sides. Composing
 * over `lexicalNorm` is what makes one entry cover them all.
 *
 * TOTAL, like the layer beneath it: a norm with no vocabulary entry maps to
 * itself. ADR-0037 §6 builds `alias` as a lookup against the TRANSITIVE CLOSURE
 * of at-most-one-parent approved edges, so an effective target is already its
 * own target and `f(f(x)) === f(x)` falls out — but only if every input has an
 * answer. (Do NOT call that a "forest invariant". §6 retracts T3's, by name, as
 * self-contradictory — depth-1 AND composing — and lists it under the ADR's
 * "Corrections to the record".)
 *
 * ## What the signature cannot say, and what {@link slotKey} does about it
 *
 * `(norm: string) => string` expresses totality and NOTHING ELSE. It cannot say
 * that the input is a norm, and — the half that bites — it cannot say the OUTPUT
 * must be one. A vocabulary row authored as `is priced at → "Priced At"` (an
 * admin typing the canonical DISPLAY form, the likeliest authoring mistake once
 * this is a reviewed data table) would otherwise store a key that joins nothing,
 * corpus-wide and silently. `slotKey` re-norms the result rather than trusting
 * it; see there.
 *
 * ## A throwing alias is NOT caught, deliberately
 *
 * `reconcile.ts` catches a throwing `EntityResolver` and degrades the candidate
 * to provisional, and the opposite choice here is the point of the asymmetry: an
 * unresolved ENTITY is a quality failure a reviewer can repair, while a
 * vocabulary lookup that fails has no safe degraded answer. Falling back to the
 * un-aliased norm would key the row into the slot the vocabulary exists to move
 * it OUT of — an under-match today, and an over-match the moment an entry merges
 * two spellings — and neither is visible afterwards. So it propagates: a
 * data-backed alias that throws aborts the episode before the transaction opens,
 * and the episode stays on the queue for the next cycle.
 *
 * Since #5022 the REALISTIC failure has moved one layer up, and the arm is kept
 * anyway. The lookups `loadClaimVocabulary` returns are `identityAlias` or a
 * pure `Map#get` closure, neither of which can throw; what can fail is the LOAD,
 * and `lib/brain/vocabulary.ts` makes the same choice there for the same reason
 * ("Errors propagate"). This arm still binds hand-written and future lookups —
 * a vocabulary that consulted a cache or a remote would put the throw back here.
 */
export type AliasLookup = (norm: string) => string;

/**
 * The empty lookup at ONE position: every norm is its own alias.
 *
 * Not "the empty vocabulary" — that is {@link identityVocabulary}, which is what
 * a call site names. Keeping the two distinct is the same distinction
 * {@link ClaimVocabulary} exists to enforce: a single `AliasLookup` is a
 * position's answer, never a workspace's.
 */
export const identityAlias: AliasLookup = (norm) => norm;

/**
 * A claim's three slots. The vocabulary is scoped by these, and so is
 * everything downstream of it.
 */
export const SLOT_POSITIONS = [
  "subject",
  "predicate",
  "object",
] as const satisfies readonly ExportedVocabularySlotPosition[];
export type SlotPosition = (typeof SLOT_POSITIONS)[number];

/**
 * The internal and wire spellings of a slot position must stay the same set.
 *
 * `ExportedVocabularySlotPosition` (`@useatlas/types`) is the region bundle's
 * copy, and there IS house precedent for duplicating a small union across that
 * boundary (`BrainEntityRole` vs `EntityRole`). The `satisfies` above proves
 * every internal member is legal on the wire; this proves the reverse, so
 * neither side can drift alone. Shaped on `_BrainFactStatusesCovered` in
 * `packages/schemas/src/brain.ts`.
 *
 * What it buys over the status quo is WHERE the drift surfaces, and the honest
 * version is narrower than an earlier draft of this comment claimed. Wire-side
 * drift is already a compile error at `admin-migrate.ts`'s
 * `Set<SlotPosition>.add(edge.slotPosition)` — but only for as long as that site
 * keeps its cast off. Pinned here, drift fails at the DEFINITION, where nobody
 * can suppress it with an `as`. (It does not prevent a runtime CHECK violation:
 * a wire member the internal union lacks is refused by {@link isSlotPosition}
 * in `validateBundle` and never reaches an INSERT.)
 */
type _SlotPositionsCoverTheWire = [
  Exclude<ExportedVocabularySlotPosition, SlotPosition>,
] extends [never]
  ? true
  : never;
const _slotPositionsCoverTheWire: _SlotPositionsCoverTheWire = true;
void _slotPositionsCoverTheWire;

/**
 * Narrow an untrusted value to a {@link SlotPosition}.
 *
 * Shaped on `isEpisodeSource` (`lib/brain/sources.ts`), and it exists for the
 * same reason: the region importer reads positions off a bundle, and
 * `(SLOT_POSITIONS as readonly string[]).includes(v as string)` is a cast that
 * lies about `unknown` and happens to behave. A guard narrows instead, which is
 * what lets the INSERT site drop its own `as SlotPosition`.
 */
export function isSlotPosition(value: unknown): value is SlotPosition {
  return typeof value === "string" && (SLOT_POSITIONS as readonly string[]).includes(value);
}

/**
 * The workspace's vocabulary — one {@link AliasLookup} per claim slot.
 *
 * ## Why this is not a single lookup, which is the shape #5020 left behind
 *
 * #5020 hung a bare `AliasLookup` on `ReconcileRequest` and expected slice B to
 * drop a data-backed function into it without editing anything. That would have
 * threaded ONE vocabulary through all three `slotKey` calls, and ADR-0037 §6
 * rules that out: a position-agnostic vocabulary does not merely PERMIT
 * cross-position composition, it COMPELS it. `owned by → platform` plus
 * `platform → platform team` puts two edges in one chain, the closure composes
 * them, and a PREDICATE approval has re-keyed SUBJECTS workspace-wide —
 * silently, and in the direction nothing can undo, since once two spellings
 * share a key nothing in the key column tells them apart.
 *
 * A record rather than a `(position) => AliasLookup` function so the call sites
 * read `vocabulary.subject` / `.predicate` / `.object` beside the surface they
 * are keying. That is the property worth buying: applying the predicate
 * vocabulary to a subject stops being a plausible slip and becomes a visibly
 * wrong line. The store (`lib/brain/vocabulary.ts`) enforces the same split in
 * the schema, so neither layer relies on the other to hold it.
 *
 * ## Loaded once, per workspace, above the loop
 *
 * `AliasLookup` is synchronous, so a DB-backed vocabulary has to be materialized
 * before the per-candidate work starts — which is also what makes it a
 * consistent snapshot for the whole episode rather than three reads that could
 * straddle an approval.
 */
export type ClaimVocabulary = Readonly<Record<SlotPosition, AliasLookup>>;

/**
 * The empty vocabulary at every position — a workspace that has approved no
 * alias, and the explicit choice every non-ingest call site makes.
 *
 * Named rather than defaulted, for {@link slotKey}'s reason: a site that
 * silently fell back to this would key its rows under a DIFFERENT identity
 * function than the ingest path, spreading an under-match corpus-wide that is
 * invisible at rest and unfixable without a re-key.
 */
export const identityVocabulary: ClaimVocabulary = {
  subject: identityAlias,
  predicate: identityAlias,
  object: identityAlias,
};

/**
 * A claim slot's stored key — `alias(lexicalNorm(surface))`, or `null`.
 *
 * THE call site for the whole composition. `reconcile.ts` materializes all
 * three of a candidate's keys through this function before `INSERT_FACT_SQL`
 * (#5020), and no consumer ever re-derives one: ADR-0037 §8 settles that even a
 * row-copy path carries keys VERBATIM, because re-deriving fails to OVER-match
 * — the irreversible direction — where carrying fails to under-match.
 *
 * ## The vocabulary's answer is re-normed, not trusted
 *
 * `identityKey(alias(norm))`, not `alias(norm)`. `lexicalNorm` is idempotent, so
 * for a well-behaved vocabulary — one whose targets are already norms — this is
 * a no-op and the composition is exactly `alias(lexicalNorm(surface))`. For a
 * MISBEHAVING one it is the difference between a harmless correction and a
 * silent corpus-wide under-match, because `alias` is going to be a data table
 * with a reviewer behind it and not a proof: `Priced At` as an entry's target
 * keys nothing to anything, and nothing anywhere would say so.
 *
 * It also subsumes the empty-string arm rather than special-casing it. A
 * vocabulary that maps a real norm to `""` (or to `" - "`) reaches the same
 * `null` as a surface that norms away, and that is the right answer for the
 * `DEFAULT ''` reason migration 0187's header gives: a stored `""` is the ONE
 * key value that joins every other degenerate row, so two unrelated claims would
 * occupy one slot and publishing either would stamp `valid_to` on the other.
 *
 * ## Two ways to reach `null`
 *
 * The surface norms away (`-`, `___`, `  `) — {@link identityKey}'s case, and
 * the alias is never consulted, because a claim that asserts nothing has no slot
 * to look up and calling out with `""` would invite a vocabulary that answers
 * it. Or the vocabulary's own answer norms away, per the paragraph above.
 *
 * ## `alias` is REQUIRED, and since #5022 the danger it names is live
 *
 * It would default to {@link identityAlias} perfectly well, and a default is
 * precisely what makes that dangerous now that the vocabulary is a real table
 * (#5022): a call site that forgot to pass the workspace's vocabulary would keep
 * compiling and key its rows under a DIFFERENT identity function than the ingest
 * path — an under-match spread corpus-wide, invisible at rest, and unfixable
 * afterwards without a re-key.
 *
 * Spelled explicitly, every such site is `grep identityVocabulary` and every new
 * one is a compile error. `reconcile.ts` threads the workspace's vocabulary
 * through the REQUIRED `ReconcileRequest.vocabulary` — three lookups, one per
 * slot, since #5022 made the vocabulary position-scoped — and `correction.ts`
 * through the required `CorrectionRequest.vocabulary` (on the REQUEST, not the
 * deps bag beside the test seams: it is workspace state). Everything else names
 * {@link identityVocabulary} out loud, which is the choice being made and should
 * read like one.
 *
 * Note what this does NOT do: collapse a null key into a sentinel so the
 * eventual `SET NOT NULL` can land. See {@link identityKey}'s ⚠️ — the
 * constraint's prerequisite is a TIGHTER ingest guard, not a wider key.
 */
export function slotKey(surface: string, alias: AliasLookup): string | null {
  const norm = identityKey(surface);
  if (norm === null) return null;
  return identityKey(alias(norm));
}
