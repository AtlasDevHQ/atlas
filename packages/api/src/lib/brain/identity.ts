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
 * ⚠️ NULL used to OVERLOAD the column — "no writer has keyed this row yet"
 * (transient) and "this surface norms away" (permanent, and legal) — and
 * `SET NOT NULL` could not land while the second was a storable state. #5047
 * closed it at the ingest guard: `reconcile.ts`'s `MALFORMED_CLAIM` now refuses
 * a candidate whose `slotKey` is null, and migration 0194 flipped all three
 * columns to `NOT NULL`.
 *
 * So this function's `null` is a REFUSAL signal now, never a stored value. 0194's
 * header carries the argument, including what became of the legacy rows that
 * held the second meaning.
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
 * The namespace for a key that stands in for NO IDENTITY (#5047, migration 0194).
 *
 * `brain_facts`' three key columns are `NOT NULL`, and two writers meet rows that
 * have no key to write: migration 0194, sweeping the legacy population whose
 * SURFACES normalize away, and the region importer, landing a fact whose surface
 * does the same. Both write `` `${UNKEYABLE_KEY_PREFIX}${factId}` `` and TOMBSTONE
 * the row.
 *
 * ## Why a per-row value, and not the sentinel 0187 rejects
 *
 * Migration 0187's header rejects a sentinel key as *"the one-slot-for-every-
 * placeholder hazard"* — a SHARED value under which every degenerate row joins
 * every other one, so two unrelated placeholder claims occupy one slot and
 * publishing either stamps `valid_to` on the other. Interpolating the row's own
 * id removes exactly that: the value equals itself and nothing else.
 *
 * ## Why it can never collide with a real key
 *
 * {@link lexicalNorm} collapses every run of `[ \t\n\v\f\r_-]` to a single space
 * and then trims, so its output can neither START with `-` nor CONTAIN one. Every
 * key in the corpus is that function's output — including a key carried verbatim
 * from another region (#5035), which is the SOURCE region's `lexicalNorm` output.
 * So no computed key can equal a placeholder, at any position, in any region.
 *
 * ⚠️ That is a property of `lexicalNorm`, not a convention, and it is what the
 * whole scheme rests on — so it is pinned by a falsifier in `identity.test.ts`
 * rather than argued here. **A change to {@link SEPARATOR_RUN} that stops
 * treating `-` as a separator silently makes placeholders forgeable**, and the
 * test is what says so.
 *
 * ## The migration cannot import this
 *
 * A `.sql` migration is frozen the moment it ships, so 0194 spells the same
 * prefix as a literal. That duplication is deliberate and bounded — 0194 is
 * history and will never move — but it is why this constant exists at all rather
 * than the string being inlined at its one TypeScript call site: the importer and
 * the migration have to agree, and a named constant is what a reader greps.
 */
export const UNKEYABLE_KEY_PREFIX = "-unkeyable:";

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
 * `reconcile.ts` catches a throwing `EntityResolver` and degrades that episode's
 * candidates to provisional, and the opposite choice here is the point of the
 * asymmetry: an entity the store could not name costs the object the store's
 * id — it falls back to whatever the surface parses to, which for a name is
 * nothing — and the row still keys and still corroborates.
 * When the store did not ANSWER at all, the row is additionally marked, and the
 * marker says only "recompute this object's comparison once it does" (#5031).
 * A vocabulary lookup that fails has no such safe degraded answer. Falling back
 * to the
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
 * The `brain_facts` surface and key columns at one slot position.
 *
 * The value type is a MAPPED type rather than `{ surface: string; key: string }`,
 * so `object: { surface: "subject", key: "object_key" }` — the cross-position
 * slip ADR-0037 §6 calls unrecoverable — does not compile, and neither does a
 * misspelled key column. The looser spelling left both to a `-pg` suite.
 *
 * Lives HERE rather than in a consumer because it has two of them and the
 * question it answers ("which column carries this position") is identity's, not
 * either caller's. It arrived as a private const in `vocabulary-decide.ts` (the
 * drift re-key's), and #5087's positional-visibility seam needed the same map —
 * at which point a second copy would have been two spellings of the slip this
 * type exists to make uncompilable.
 */
export type SlotColumns = {
  readonly [P in SlotPosition]: { readonly surface: P; readonly key: `${P}_key` };
};
export const SLOT_COLUMNS: SlotColumns = {
  subject: { surface: "subject", key: "subject_key" },
  predicate: { surface: "predicate", key: "predicate_key" },
  object: { surface: "object", key: "object_key" },
};

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
 * one is a compile error — which is exactly how #5023 found the four that had
 * to change. `reconcile.ts` threads the workspace's vocabulary through the
 * REQUIRED `ReconcileRequest.vocabulary` — three lookups, one per slot, since
 * #5022 made the vocabulary position-scoped — and `correction.ts` through the
 * required `CorrectionRequest.vocabulary` (on the REQUEST, not the deps bag
 * beside the test seams: it is workspace state). Production supplies both from
 * `loadWorkspaceVocabulary`; {@link identityVocabulary} survives as the answer
 * for a workspace that has approved nothing, and as what a test names when it
 * means "no vocabulary" rather than "I forgot".
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

// ---------------------------------------------------------------------------
// The inherit channel (#5037)
// ---------------------------------------------------------------------------

/**
 * Slot keys COPIED off an existing fact row — the row-copy half of ADR-0037 §8's
 * *a row-copy path carries keys verbatim; a claim-supply path never supplies
 * them.*
 *
 * ## Why this exists at all
 *
 * ADR-0037 §1 forbids a producer supplying identity, and that prohibition is what
 * keeps canonicalization at the one seam. `correction.ts` is the one caller that
 * needs a doorway through it, and the distinction that earns the doorway is
 * narrow: it does not COMPUTE a key, it COPIES one off the row it is correcting.
 * ADR-0037 §8 calls region import and `correction.ts`'s inherit-identity-from-
 * target the same operation for that reason.
 *
 * Without the doorway `correction.ts` re-derives `alias_now(lexicalNorm(
 * target.subject))` and gets the target's stored key only while the vocabulary
 * has not moved. Three ways it has — an alias removal, a correction racing the
 * drift rewrite, and a row whose keys a region import carried from a FOREIGN
 * vocabulary (#5035) — and on any of them the id-based stamp still fires, so the
 * target is retired and its replacement lands in a DIFFERENT slot: unreachable
 * from the slot every future collision joins on. The audit trail says
 * "superseded by X"; the slot says empty.
 *
 * ## Why it is a CLASS with a private field, and not a phantom-symbol brand
 *
 * ADR-0037's accepted cost for the doorway is that it *"must be typed so it
 * cannot be filled from thin air — inherited-from-a-row-id, not free strings"*.
 *
 * ⚠️ A `unique symbol` phantom brand — the repo's usual shape, and what this
 * type carried first — does NOT deliver that, because **a symbol-keyed brand
 * survives object spread**. This compiles, with no assertion and without
 * importing the constructor:
 *
 * ```ts
 * const forged: InheritedSlot = { ...target.slot, subject: slotKey(surface, vocab) };
 * ```
 *
 * That is not an exotic bypass. *"Copy the slot but recompute one position"* is
 * the single most likely future edit at this seam, it reintroduces exactly the
 * defect #5037 removes, and it slips past a `slotKey(target.…)` lexical ratchet
 * because the argument is a surface rather than the target. A `#private` field
 * is not spreadable, so the same line fails to type-check — the guarantee is the
 * compiler's rather than a reviewer's.
 *
 * A single `as InheritedSlot` still forges either shape. That is inherent to
 * nominal typing in TypeScript and is acceptable: an assertion is visible in
 * review, and Atlas already treats one as something to justify.
 *
 * ⚠️ The type alone would still admit a caller that COMPUTED two keys and handed
 * them to the mint — `slotKey` is exported, so no projection is needed to hold a
 * key. The compensating pin is `correction.test.ts`'s call-site assertion, which
 * keeps {@link inheritSlotFromFactRow} reachable from this file and
 * `correction.ts` only. The type stops a slot being FORGED; that pin stops one
 * being MINTED somewhere it has no business being.
 *
 * ⚠️ That pin is a grep on ONE identifier, so the number of exported mints is
 * load-bearing and not an implementation detail. An earlier cut of this fix
 * exported the class, which made `InheritedSlot.fromRow(…)` a second, unpinned
 * mint — the same forge the `#private` field had just closed, returning as
 * destructure-and-rebuild, with the marker attached by the constructor for the
 * caller. Exporting only the type is what keeps "one mint" true rather than
 * merely intended. **Adding a second construction path means adding it to that
 * grep in the same commit.**
 *
 * ## What travels, and what does not
 *
 * The SLOT — subject and predicate. Not the object: a correction is *about this
 * claim*, so its slot is the target's, but the replacement's object is new and
 * human-authored and keys on its own terms. Inheriting the object key would make
 * the replacement byte-identical to the target at every identity position, which
 * is the one thing a supersession must not be.
 *
 * ## Named by ROLE, constructed from the COLUMNS
 *
 * The two exposed keys are `subject` / `predicate`, not `subjectKey` /
 * `predicateKey`, for the reason `reconcile.ts`'s `SlotKeys` already gives:
 * `keys-not-on-the-wire.test.ts` bans those three identifiers outright in any
 * file that speaks about `brain_facts`, because a fact-shaped TYPE growing a key
 * field is the leak it exists to catch and it cannot tell one from a local. This
 * type never reaches a row type or a wire type, so it takes the same naming
 * rather than a fourth exemption.
 *
 * Role names on a KEYS type would normally be a footgun — `{ subject, predicate }`
 * is also the shape of a claim's SURFACES, and handing the surfaces to a function
 * that wanted keys is a silent, exactly-wrong call. {@link inheritSlotFromFactRow}
 * closes that by taking the raw `pg` row and its SQL column spellings
 * (`subject_key`), which no surface-shaped object satisfies. The disambiguation
 * lives at the one place a value can be built, so the ergonomic names are safe
 * everywhere they are read.
 */
class InheritedSlotValue {
  /**
   * The nominal marker. `#private`, so the type cannot be satisfied by an object
   * literal or by spreading an existing instance — see the docstring above for
   * why the phantom-symbol spelling was not enough.
   */
  readonly #inherited = true;

  private constructor(
    /**
     * The `brain_facts.id` these keys were read from.
     *
     * Carried rather than dropped so the value names its own provenance, and
     * READ rather than merely stored: `applySupersede` asserts it against the
     * target it is correcting. A slot built from one row and attached to a
     * candidate about another has no other detector, and a field nothing checks
     * would be documentation with a runtime cost.
     */
    readonly fromFactId: string,
    /** The target's stored subject key, verbatim. `null` is a legal stored value. */
    readonly subject: string | null,
    /** The target's stored predicate key, verbatim. `null` is a legal stored value. */
    readonly predicate: string | null,
  ) {}

  /**
   * ⚠️ NOT REACHABLE OUTSIDE THIS MODULE, and that is the whole point.
   *
   * Only the TYPE is exported (`export type InheritedSlot = InheritedSlotValue`),
   * so there is no exported VALUE named `InheritedSlot` and this static cannot be
   * addressed from another file. An earlier cut exported the class, which made
   * `InheritedSlot.fromRow({ id: slot.fromFactId, subject_key: computed, … })` a
   * second mint — the same forge the `#private` field had just closed, returning
   * as destructure-and-rebuild through the fix's own constructor, with the marker
   * attached for the caller. One exported mint, one name to pin.
   */
  static fromRow(row: {
    readonly id: string;
    readonly subject_key: string | null;
    readonly predicate_key: string | null;
  }): InheritedSlotValue {
    return new InheritedSlotValue(row.id, row.subject_key, row.predicate_key);
  }

  /** Silences the unused-private-member reading; the field exists to be nominal. */
  get inherited(): boolean {
    return this.#inherited;
  }
}

/**
 * The nominal type. The CLASS is deliberately not exported — see
 * {@link InheritedSlotValue.fromRow} — so {@link inheritSlotFromFactRow} is the
 * only way to obtain one from outside this module.
 */
export type InheritedSlot = InheritedSlotValue;

/**
 * The one constructor for {@link InheritedSlot}.
 *
 * Takes the RAW ROW — `pg`'s snake_case column keys, exactly as the driver hands
 * them back — rather than three strings. Two things follow from that, and both
 * are the point:
 *
 *   - The call site reads as a copy, and the fact id travels with the keys it
 *     belongs to, so nothing can quietly attach one row's slot to another row's
 *     correction.
 *   - The parameter cannot be satisfied by a claim's surfaces. `{ subject,
 *     predicate }` would type-check against a role-named parameter and mean the
 *     opposite of what it says; `{ subject_key, predicate_key }` is a shape only
 *     a fact row has.
 *
 * `null` keys pass through unchanged and deliberately: an unkeyed legacy row's
 * slot is `(NULL, NULL)`, which joins nothing — and re-deriving a key for it here
 * would invent identity for a row that has none, silently moving it into a live
 * slot. Carrying the nulls preserves today's behaviour for that row, which is the
 * conservative direction (#5035's null-at-import rule makes the same call for the
 * same reason).
 *
 * ⚠️ That preservation is not PERMANENT — but since #5047 it is not
 * unconditional either, and the difference matters because the conservative
 * argument above reads as if the repair were guaranteed.
 * `REKEY_DRIFTED_FACTS_SQL` (`vocabulary-decide.ts`, #5024) rewrites every key in
 * the workspace that is not a fixpoint of the local vocabulary at the next alias
 * decision. Nothing breaks: the target is rewritten by the same statement, so the
 * pair moves together and stays in one slot.
 *
 * What that statement can no longer do is repair a row whose RECOMPUTED key is
 * null. #5047 added an `IS NOT NULL` arm — the key columns are `NOT NULL` since
 * migration 0194, so writing one would raise `23502` and abort a human-gated
 * approval — and #5109 counts the declined rows precisely because their
 * unkeyedness does NOT expire. So: an inherited null over a surface that KEYS
 * loses its unkeyedness at the next decision; an inherited null over a surface
 * that norms away keeps it forever, and the re-key reports it rather than fixing
 * it. In both cases what survives is the inheritance, not the unkeyedness.
 */
export function inheritSlotFromFactRow(row: {
  readonly id: string;
  readonly subject_key: string | null;
  readonly predicate_key: string | null;
}): InheritedSlot {
  return InheritedSlotValue.fromRow(row);
}

// ---------------------------------------------------------------------------
// The SQL twin (#5024)
// ---------------------------------------------------------------------------

/**
 * {@link lexicalNorm}, as a SQL expression over an arbitrary column expression.
 *
 * ## Why this exists, and why it lives HERE rather than beside its caller
 *
 * The header above calls migration 0187 "a SECOND implementation of this
 * function, written in SQL", and names the consequence: *two implementations
 * that disagree on any input are two functions*. #5024's drift re-key needs the
 * same normalization a THIRD time — it recomputes a key from the retained
 * surface inside the decide transaction — and a third hand-written copy is how
 * a set of three becomes a set of two-that-agree-and-one-that-does-not.
 *
 * So the expression is generated once, here, beside the TypeScript it must
 * match. 0187 cannot import it (a `.sql` migration is frozen the moment it
 * ships, and rewriting an applied migration is worse than duplicating a
 * string), so the pinning is what carries the guarantee instead. Both proofs
 * live in `vocabulary-rekey-pg.test.ts`:
 *
 *   - it runs this expression and {@link lexicalNorm} over one corpus row by
 *     row, including the two measured Unicode counter-examples below and a real
 *     U+000B; and
 *   - it asserts this expression is textually what 0187's `UPDATE` already
 *     contains, WHITESPACE-COLLAPSED — 0187 column-aligns its arguments
 *     (`translate(subject,   '…`), so a raw substring test holds for
 *     `predicate` and fails for the other two.
 *
 * (`identity-pg.test.ts` is the separate, older pinning of 0187 against
 * `lexicalNorm`, row by row over its own corpus. It does not reference this
 * function at all — do not read it as covering the SQL twin.)
 *
 * Not a database dependency, despite the name — this module imports no runtime
 * value (only a type, erased at compile time) and still holds only the pure
 * lexical layer. It emits a string.
 *
 * ## The spelling is 0187's, character for character, and every choice is load-bearing
 *
 *   - `translate()` and NOT `lower()` — the fold is `A`–`Z` only. See the
 *     header's two measured counter-examples (U+0130, word-final sigma);
 *     `lower()` is collation-dependent, so a key would depend on WHERE it was
 *     computed.
 *   - The separator class is built with `chr()` rather than written
 *     `'[ \t\n\v\f\r_-]+'`. Under `standard_conforming_strings = off` the
 *     readable spelling drops the `\v` escape and shreds every key containing a
 *     `v` (`leaves` → `lea es`), and a `SET LOCAL` at the top of a file does not
 *     fix it — the runner sends the file as one simple-query message and
 *     Postgres lexes the whole message before executing any of it. `chr()` has
 *     no escapes to process and is therefore correct under either setting.
 *   - `btrim(…, ' ')` is the twin of `EDGE_SPACE`, applied AFTER the collapse
 *     has left at most one space at each end.
 *   - `-` sits LAST inside the bracket so it reads as a literal rather than
 *     opening a range, exactly as {@link SEPARATOR_RUN} does.
 *
 * This is `lexicalNorm` alone — TOTAL, and `''` is a legal answer. The
 * `NULLIF(…, '')` that turns a norm into a stored KEY is
 * {@link identityKeySql}, kept separate for the reason {@link identityKey} is.
 *
 * @param columnExpr a SQL expression yielding text. Interpolated verbatim, so
 *   callers pass an identifier or expression they control — the same contract
 *   `brainFactStatusClause` and `supersessionCollisionJoin` carry.
 */
export function lexicalNormSql(columnExpr: string): string {
  return (
    `btrim(regexp_replace(translate(${columnExpr}, ` +
    `'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), ` +
    `'[ ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || '_-]+', ' ', 'g'), ' ')`
  );
}

/**
 * {@link identityKey} as a SQL expression — the norm, or NULL when it is empty.
 *
 * The storage decision, split from the normalization for the reason
 * {@link identityKey} gives: a stored `''` is the ONE key value that joins every
 * other degenerate row, so two unrelated placeholder claims would occupy one
 * slot and publishing either would stamp `valid_to` on the other.
 */
export function identityKeySql(columnExpr: string): string {
  return `NULLIF(${lexicalNormSql(columnExpr)}, '')`;
}

// ---------------------------------------------------------------------------
// The identity-mutation advisory lock (#5024, ADR-0037 §7)
// ---------------------------------------------------------------------------

/**
 * Advisory-lock namespace for IDENTITY mutation — this issue's number, the
 * convention `RECONCILE_LOCK_NAMESPACE` (4771) set and `VOCABULARY_LOCK_NAMESPACE`
 * (5022) followed.
 *
 * ## What it serializes, and why neither existing namespace could do it
 *
 * Two writers decide what a claim COLLIDES with, and until #5024 nothing
 * serialized them:
 *
 *   - The **drift re-key** (`lib/brain/vocabulary-decide.ts`) rewrites a
 *     position's keys workspace-wide when an alias is approved or removed.
 *   - The **publish gate** (`lib/content-mode/adapters/brain-facts.ts`) reads
 *     collision pairs with `SUPERSESSION_TARGETS_SQL` and then stamps `valid_to`
 *     on the published side. The published rows are NOT covered by
 *     `DRAFT_FACTS_SQL`'s `FOR UPDATE`, which locks drafts.
 *
 * Alias ADDITION only creates collisions, which is safe — a pair that starts
 * colliding mid-publish is simply not stamped this time round. Alias REMOVAL
 * de-merges keys, and a removal landing between that SELECT and that UPDATE
 * stamps `valid_to` on a pair that no longer collides: a belief retired by an
 * arbitration that no longer holds, invisibly, since every as-of-now read then
 * hides the row it touched.
 *
 * **NOT `RECONCILE_LOCK_NAMESPACE` (4771).** Reusing it would serialize publish
 * against the extraction fiber, and `brain-facts.ts` argues at length that
 * publish must never be wedged by ingest — *"Refuse the row, never the
 * workspace"*. Reconcile does not take this one either: a row inserted
 * mid-approval gets the pre- or post-approval key, which is an under-match and
 * recoverable, where blocking ingest on a human-paced approval is not.
 *
 * **NOT `VOCABULARY_LOCK_NAMESPACE` (5022).** That one is held by the region
 * importer for its whole edge-insert loop, and publish has no business waiting
 * behind a migration. The two are taken TOGETHER, in one fixed order, by the one
 * caller that mutates both relations — see below.
 *
 * ## Lock ORDER, which is the part a redundancy argument gets wrong
 *
 * The decide transaction takes **5022 then 5024**. Publish takes **5024 only**.
 * No wait-for cycle can form: nothing that holds 5024 ever asks for 5022.
 *
 * The region importer is the exception worth stating precisely, because the
 * obvious summary is wrong: it INSERTs `brain_facts` (and conversations,
 * entities, episodes) **before** it takes 5022, and takes 5022 only when the
 * bundle carries vocabulary edges at all. So "every actor locks before it
 * touches rows" is FALSE. What actually keeps it safe is narrower: the importer
 * only ever INSERTs into `brain_facts`, and an uncommitted INSERT blocks no
 * UPDATE, so the re-key never waits on it. **An importer that ever UPDATEs an
 * existing fact row before taking 5022 closes the cycle** — that is the change
 * to watch for, not a reordering of the locks here.
 *
 * That ordering is not incidental and it is not free to change. #5022's review
 * found a real `40P01 deadlock detected` produced by removing a lock that
 * "looked redundant because the later call takes it anyway" — the question a
 * redundancy argument about locks has to answer is *"does the later lock block
 * in the same place?"*, and outcome-equivalence is not an answer. If a future
 * caller takes 5024 before 5022, the cycle is immediate and it will kill region
 * imports intermittently rather than loudly.
 */
export const IDENTITY_MUTATION_LOCK_NAMESPACE = 5024;

/**
 * Taken on the WORKSPACE, matching `VOCABULARY_LOCK_SQL`.
 *
 * `pg_advisory_xact_lock`, so it releases at COMMIT and a caller cannot leak it
 * — which also means it does nothing at all outside an explicit transaction.
 * Both call sites are inside one; `vocabulary.ts`'s `VOCABULARY_LOCK_HELD_SQL`
 * is the shape to copy if a third ever needs proof rather than discipline.
 */
export const IDENTITY_MUTATION_LOCK_SQL = `SELECT pg_advisory_xact_lock($1, hashtext($2))`;

/**
 * The bound that makes the wait above FAIL rather than hang.
 *
 * `pg_advisory_xact_lock` does not error on contention — it waits, forever. So
 * the `catch` around it never runs for the one failure that matters, and a
 * publish request that lands while a decide transaction holds this namespace
 * hangs with no log line, no `requestId` and no response: precisely the
 * undebuggable shape CLAUDE.md's error rules exist to prevent, and one that no
 * test can see because every lock test asserts that blocking is CORRECT.
 *
 * The exposure is real rather than theoretical now that the decide transaction
 * holds this lock across a deliberately-unindexed workspace-wide scan.
 *
 * ## It MUST be reset, and that is the whole subtlety
 *
 * `SET LOCAL` reverts at COMMIT, not at the next statement — so a bound set and
 * left in place governs **every subsequent lock wait in the transaction**, which
 * at both call sites is a lot more than the acquisition it was written for:
 *
 *   - on the publish path, the promote UPDATEs and the supersede stamp, which
 *     contend for `brain_facts` row locks with `reconcile.ts` and
 *     `correction.ts` — both of which take namespace 4771, NOT this one, so the
 *     advisory lock does not serialize them; and, because `runPublishPhases` is
 *     not the last thing in `admin-publish.ts`'s transaction, the phase-4
 *     connection-archive loop's `FOR UPDATE` on `workspace_plugins`.
 *   - on the decide path, the proposal claim and every row lock the
 *     workspace-wide re-key takes.
 *
 * Note what is NOT in that list, because an earlier draft led with it and it was
 * wrong: `DRAFT_FACTS_SQL`'s `FOR UPDATE`. Publisher-versus-publisher contention
 * there is already impossible — this namespace is taken and held before the
 * drafts are read, so a second publisher parks on the advisory lock and never
 * reaches the row lock. It stays out of the list; the two entries above carry
 * the argument on their own. (5022 is likewise absent from the decide entry: it
 * is taken BEFORE the bound.)
 *
 * Turning those waits into failures is a behaviour change nobody asked for: a
 * publish that used to block for eleven seconds and commit would instead roll
 * back everything already promoted, under a generic message, on a class that is
 * transient. So {@link IDENTITY_MUTATION_LOCK_RESET_SQL} is issued immediately
 * after the acquisition and the pair is what callers use. Getting this wrong is
 * exactly what happened on the first cut, and both reviewers caught it.
 *
 * `residency/cleanup.ts:432` uses the un-reset shape, and the difference is why
 * it is not precedent here: there the `SET LOCAL` is the first statement of a
 * transaction that same function owns end to end, so transaction-wide scope IS
 * the intent. Here it is issued mid-transaction by one phase of a multi-phase
 * transaction owned by another module.
 *
 * On timeout Postgres raises `55P03 lock_not_available`. The PUBLISH caller
 * turns that into a typed refusal naming the contending operation and telling
 * the caller to retry; the decide caller lets it propagate untyped for now, and
 * #5025 — which is what gives that path an HTTP route to answer — is where it
 * gets a message. Said plainly because the symmetric claim reads true and is not.
 *
 * 10s bounds the wait against the DECIDE transaction's deliberately-unindexed
 * workspace-wide re-key scan — a machine-paced duration, not the human's
 * deliberation, which happens before the request. Far shorter than a proxy's
 * idle timeout, so the failure surfaces as our message rather than as a dropped
 * connection.
 */
export const IDENTITY_MUTATION_LOCK_TIMEOUT_SQL = `SET LOCAL lock_timeout = '10s'`;

/**
 * Undo {@link IDENTITY_MUTATION_LOCK_TIMEOUT_SQL} — issued immediately after the
 * acquisition so the bound covers that statement and nothing else.
 *
 * `DEFAULT` rather than `'0'`: it restores the RESET VALUE — compiled-in,
 * `postgresql.conf`, `ALTER DATABASE`, `ALTER ROLE` — rather than asserting "no
 * timeout", which would silently override a `lock_timeout` an operator set on
 * purpose. Measured against this repo's PG 16: with `ALTER ROLE … SET
 * lock_timeout='45s'`, `DEFAULT` restores `45s`.
 *
 * ⚠️ A SESSION-level `SET lock_timeout` would NOT survive it — `DEFAULT` resets
 * to the reset value, not to the session value, so the rest of the transaction
 * would run at the server default instead. No pool in `lib/db/internal.ts` sets
 * one today (no `connect` hook anywhere in `packages/api`), which is the only
 * reason this spelling is safe. Revisit here before adding one.
 */
export const IDENTITY_MUTATION_LOCK_RESET_SQL = `SET LOCAL lock_timeout = DEFAULT`;

/** Postgres' SQLSTATE for a `lock_timeout` expiry. */
export const LOCK_NOT_AVAILABLE = "55P03";

/** Whether an unknown error is a `lock_timeout` expiry rather than a real fault. */
export function isLockTimeout(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === LOCK_NOT_AVAILABLE
  );
}
