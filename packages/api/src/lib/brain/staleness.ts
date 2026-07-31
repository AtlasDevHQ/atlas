/**
 * Read-time staleness decay for brain facts (#4914, ADR-0036 §Temporal).
 *
 * T4's stance, made computable: **staleness is advisory at ingest,
 * authoritative at the gate; decay only surfaces, never auto-demotes.** A
 * published fact never expires, never loses its trust tier, and is never
 * demoted by any background job — but its age must be honest everywhere it
 * appears, or "staleness is the moat" is an unverifiable claim.
 *
 * ## What this module deliberately is
 *
 * A PURE derivation. There is no stored decay score, no scheduler job, and no
 * write path of any kind — the module contains read-only SQL fragments and a
 * classifier over values a read already holds. `staleness.test.ts` pins the
 * structural half (no mutating SQL statement anywhere in this file);
 * `candidates.test.ts` / `search.test.ts` pin the behavioral half (the read
 * models that call it emit only SELECTs). The single writer of
 * `brain_facts.status` stays the review-gate machinery (`promoteBrainFacts`,
 * plus `correct_fact`'s allowlisted in-transaction promote, #4915), and the
 * tombstone verb stays the `retract` correction verb (`correctFact`,
 * `lib/brain/correction.ts`); decay influences neither.
 *
 * ## The anchor, and why corroboration enters through recency
 *
 * The signal is anchored on the newest OBSERVATION of the claim — the max
 * `occurred_at` (per episode, falling back to that episode's own ingest time)
 * over the episodes its `provenance` edges point at — falling
 * back to `valid_from`, then `ingested_at`, when no observation decodes.
 * Re-observing a claim adds a provenance edge (see `CORROBORATION_SELECT` in
 * `candidates.ts`), so every corroboration moves the anchor forward: that is
 * how corroboration slows decay. It is deliberately NOT also a threshold
 * multiplier, because the level must be derivable identically in SQL (the
 * queue's surfacing hint) and in TypeScript (the wire label) — two derivations
 * of one rule, held together by the shared day constants below. A
 * corroboration-scaled threshold would be a second rule to keep in lockstep,
 * and the failure mode is a row that SORTS as stale while LABELLING itself
 * fresh.
 *
 * ## The one entitlement decision in the file
 *
 * The newest observation timestamp is episode data. For a fact with a single
 * corroborating episode it IS `attribution.occurredAt` — the "when" of the
 * withheld who/where/when triple (#4836) — and with several episodes there is
 * no way to know, without per-episode ACL checks this read does not do, whether
 * the max came from one the reader may see. So a reader whose attribution
 * decision is `withhold` gets the coarse `level` only: `lastObservedAt` and
 * `ageDays` are nulled, because a day-precision age is the withheld timestamp
 * restated as arithmetic. The level itself stays computed from the REAL anchor
 * — a ~2-bit bucket does not reconstruct a moment, and lying about the level
 * to withheld readers would defeat the surface's whole point.
 */

import type { BrainAttributionDecision } from "@atlas/api/lib/brain/attribution";
import type { BrainFactDecayView } from "@useatlas/types";

/** A claim younger than this (days) is `fresh`. */
export const DECAY_AGING_AFTER_DAYS = 30;

/**
 * A claim at least this old (days) is `stale` — and is what the review queue's
 * surfacing hint keys on. `aging` spans the band between the two.
 */
export const DECAY_STALE_AFTER_DAYS = 120;

const MS_PER_DAY = 86_400_000;

/**
 * Newest observation of the claim: max `occurred_at` (falling back to the
 * episode's own `ingested_at`) over the episodes this fact's `provenance`
 * edges point at.
 *
 * Aliases the fact table `f`, like `CORROBORATION_SELECT` beside which it is
 * always selected. Reads episode timestamps WITHOUT the episode ACL on
 * purpose: this is a server-side aggregate, and what of it reaches the wire is
 * `computeDecaySignal`'s entitlement question, not the query's — and that gate
 * is the #4836 widening decision ONLY, never a per-episode ACL check. The
 * accepted residual, stated so nobody "closes" it later: a reader inside the
 * fact's pre-widening grant receives the bare max timestamp even when the max
 * came from a corroborating episode whose own grant excludes them. A lone
 * timestamp carries none of the who/where/what the episode ACL protects
 * (compare `CORROBORATION_SELECT`, which already discloses a COUNT over the
 * same edges to the same readers); the who/where/when TRIPLE is what travels
 * with the attribution decision.
 */
export const LAST_OBSERVED_AT_SELECT = `(
    SELECT MAX(COALESCE(ep.occurred_at, ep.ingested_at))
      FROM brain_edges ed
      JOIN brain_episodes ep
        ON ep.workspace_id = ed.workspace_id
       AND ep.id = ed.to_episode_id
     WHERE ed.workspace_id = f.workspace_id
       AND ed.edge_type = 'provenance'
       AND ed.from_fact_id = f.id
  )`;

/**
 * The review queue's surfacing hint, as a boolean SQL expression: is this
 * fact's decay anchor past the stale threshold?
 *
 * SAME anchor chain as `computeDecaySignal` — observation, then `valid_from`,
 * then `ingested_at` (NOT NULL, so the expression never yields SQL NULL) —
 * and the SAME day constant, interpolated rather than restated, so the hint
 * and the label cannot disagree about what "stale" means. A hint is all it is
 * allowed to be: it appears in ORDER BY only, never in a WHERE (a stale fact
 * is surfaced, never filtered) and never anywhere near a mutating statement —
 * `staleness.test.ts` pins this whole file to read-only verbs.
 */
export const STALE_SURFACING_HINT_SQL = `(COALESCE(${LAST_OBSERVED_AT_SELECT}, f.valid_from, f.ingested_at)
    < now() - make_interval(days => ${DECAY_STALE_AFTER_DAYS}))`;

/** The raw temporal columns a read passes in — `unknown` off `pg`, like everything else in this slice. */
export interface BrainFactDecayInputs {
  /**
   * `last_observed_at` — the {@link LAST_OBSERVED_AT_SELECT} aggregate.
   *
   * `undefined` is NOT the same value as SQL `NULL`, and the classifier keys
   * on the difference: `pg` never yields `undefined` for a column it selected,
   * so `undefined` means the column is missing from the projection — a new
   * read surface, a rewritten SELECT, a row built by hand. Same distinction
   * `attributionDecision` draws on `pre_widening_visible_to`, for the same
   * reason: conflating the two turns query drift into a confident wrong label.
   */
  readonly lastObservedAt: unknown;
  readonly validFrom: unknown;
  readonly ingestedAt: unknown;
}

/** Timestamp → `Date`, or `null` when it will not parse. Never throws — mirrors `iso()` in the read models. */
function asDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" && value !== "") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/**
 * Derive the advisory decay signal for one fact row, at read time.
 *
 * Pure: no I/O, no clock of its own (`now` is an argument with a default so
 * tests pin boundaries exactly), and nothing here can reach a fact row —
 * the return value is wire data and the inputs are copies.
 *
 * `unknown` is the honest arm, not a fallback, and it covers BOTH ways the
 * inputs can be unusable: every timestamp failed to decode (query drift on the
 * columns — `ingested_at` is NOT NULL at rest), or the observation column was
 * never selected at all (`undefined`, see {@link BrainFactDecayInputs}). The
 * drift arm refuses to anchor on the fallbacks deliberately: a page whose
 * SELECT dropped `last_observed_at` would otherwise SORT by the real
 * observation (the ORDER BY hint interpolates the subquery independently)
 * while LABELLING from ingest recency — the hint/label disagreement this
 * module exists to prevent — and would do it with a confident, plausible
 * label. This module has no row id to log against, so the call sites own the
 * drift warning; the classifier's job is to make the degradation VISIBLE
 * ("age unknown") rather than wrong.
 *
 * A FUTURE anchor clamps to age 0 (`fresh`) rather than going negative — a
 * fabricated timestamp must not surface as "observed -3 days ago" with the
 * confidence of a real reading.
 */
export function computeDecaySignal(
  inputs: BrainFactDecayInputs,
  attribution: BrainAttributionDecision,
  now: Date = new Date(),
): BrainFactDecayView {
  if (inputs.lastObservedAt === undefined) {
    return { level: "unknown", ageDays: null, lastObservedAt: null };
  }
  const observed = asDate(inputs.lastObservedAt);
  const anchor = observed ?? asDate(inputs.validFrom) ?? asDate(inputs.ingestedAt);
  if (!anchor) return { level: "unknown", ageDays: null, lastObservedAt: null };

  const ageDays = Math.max(0, Math.floor((now.getTime() - anchor.getTime()) / MS_PER_DAY));
  const level =
    ageDays >= DECAY_STALE_AFTER_DAYS ? "stale" : ageDays >= DECAY_AGING_AFTER_DAYS ? "aging" : "fresh";

  // Tested against "disclose", not against "withhold" — the same polarity
  // `projectProvenance` keeps, and for the same reason: a third decision arm
  // must land on the withholding branch until somebody deliberately handles
  // it. When an observation exists, the exact timestamp AND the day-precision
  // age are the #4836 "when" and travel with the attribution decision; the
  // fallback anchors (`valid_from`, `ingested_at`) are Atlas's own disclosed
  // columns, so a fact with no decodable observation keeps its numbers.
  const disclose = attribution === "disclose" || observed === null;
  return {
    level,
    ageDays: disclose ? ageDays : null,
    lastObservedAt: disclose && observed ? observed.toISOString() : null,
  };
}
