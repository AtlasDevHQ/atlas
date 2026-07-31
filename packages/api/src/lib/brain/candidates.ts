/**
 * The fact-candidate read model behind the review surface (#4772, ADR-0036).
 *
 * The reviewer makes ONLY the trust call. Everything they need to make it —
 * the SPO claim, the provenance chain back to the episode, the derived grant,
 * the corroboration count, the provisional-entity flag, and any advisory
 * contradiction hints — is assembled here so the surface never has to reach
 * back into the substrate mid-render.
 *
 * ## What this module deliberately does NOT do
 *
 * It never promotes and it never writes `status`. Promotion runs through
 * `/api/v1/admin/publish` → `promoteBrainFacts`, the single writer of
 * `brain_facts.status` — `scripts/check-brain-fact-promotion.sh` refuses every
 * GREPPABLE status-writing shape, and its header enumerates in full what a grep
 * cannot see; the structural half is the registry-stays-`exotic` assertion in
 * `adapters/__tests__/brain-facts.test.ts`.
 * What this module offers instead is a PRE-FLIGHT: `classifyFactForPromotion`
 * is the same pure classifier the publish transaction runs, so the queue shows
 * the verdict the endpoint will reach without importing the publish machinery.
 *
 * Rejection is the `retract` correction verb (`correctFact` in
 * `lib/brain/correction.ts`, #4915) — a tombstone on `invalidated_at`, not a
 * status write. See the note at the tail of this file.
 *
 * The same posture holds for #4914's decay signal: computed at read time in
 * `staleness.ts`, surfaced on every queue row, allowed to float stale claims
 * to the top of the queue — and structurally incapable of demoting one,
 * because nothing derived from it ever appears in a WHERE or an UPDATE.
 *
 * ## How the four gates (ADR-0036) land here
 *
 *   - **ACL grant** — composed explicitly, via `aclVisibilityClause`.
 *   - **Residency** — invariant by construction; the process is the region.
 *   - **Content mode** — the reviewer's explicit status filter, NOT
 *     `brainFactStatusClause`. Deliberate: the mode clause answers "what may a
 *     reader of this workspace see right now", and a review queue exists
 *     precisely to look at drafts a mode-gated reader may not. The publish
 *     preview reads `status = 'draft'` directly for the same reason.
 *   - **Org/group reach (ADR-0022)** — not composed. A brain fact is
 *     workspace-scoped and carries no connection-group binding, so there is no
 *     reach dimension to gate on. If M2 gives a fact a group, this is the seam
 *     that has to grow a fifth clause (the supersession predicate took the
 *     fourth WHERE-clause slot, #4912 — distinct from the four ADR gates this
 *     list is counting).
 *
 * `invalidated_at IS NULL` is AND-ed on top and is NOT one of the four — it is
 * the tombstone axis, which `brainFactStatusClause` explicitly does not cover,
 * so every current-belief read has to add it itself. So is
 * `brainFactCurrentClause` (#4912), the supersession axis: a superseded fact is
 * still `published` and still not retracted, and it leaves this surface the
 * same way a tombstoned one does.
 *
 * ## The episode is gated in its own right — the likeliest leak in the slice
 *
 * A fact's grant is derived independently of its episode's. A claim extracted
 * from a private channel can legitimately be granted `org` while the message
 * that produced it stays restricted to that channel's audience. So the evidence
 * is fetched in a SEPARATE ACL-gated query against `brain_episodes` rather than
 * joined onto the fact — a join gated by the FACT's predicate would hand a
 * reviewer a private message because they were entitled to a conclusion drawn
 * from it. Same for tension counterparts, which are facts and get the fact
 * predicate applied to them independently.
 */

import { createLogger } from "@atlas/api/lib/logger";
import {
  aclVisibilityClause,
  logGrantAnomalies,
  type BrainPrincipalContext,
} from "@atlas/api/lib/brain/acl";
import { BrainReaderUnresolvedError } from "@atlas/api/lib/brain/reader-context";
import {
  attributionDecision,
  type BrainAttributionDecision,
} from "@atlas/api/lib/brain/attribution";
import { classifyFactForPromotion, type DraftFactRow } from "@atlas/api/lib/brain/promotion";
import { brainFactCurrentClause } from "@atlas/api/lib/content-mode/adapters/brain-facts";
import { loadTensionClusters } from "@atlas/api/lib/brain/tensions";
import {
  computeDecaySignal,
  LAST_OBSERVED_AT_SELECT,
  STALE_SURFACING_HINT_SQL,
} from "@atlas/api/lib/brain/staleness";
import { BRAIN_FACT_REVIEW_STATUSES, type BrainFactStatusFilter } from "@useatlas/schemas";
import type {
  BrainEntityRole,
  BrainFactAttributionView,
  BrainFactCandidate,
  BrainFactCandidateListResponse,
  BrainFactCandidateSummary,
  BrainFactEpisodeView,
  BrainFactPromotionBlock,
  BrainFactProvenanceView,
  BrainFactReviewStatus,
  BrainFactTensionView,
} from "@useatlas/types";

const log = createLogger("brain-candidates");

/**
 * The database handle this module needs.
 *
 * Structurally satisfied by `InternalPoolClient`, `pg.Pool`, and `pg.PoolClient`
 * — so callers pass their existing handle straight through, and tests pass a
 * literal with no `mock.module()` and no singleton to mutate. Mirrors
 * `AudienceMembershipReader` in `acl.ts` (and is assignable to it, so one
 * handle serves both the principal resolution and these reads).
 */
export interface BrainCandidateReader {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: readonly unknown[]; rowCount?: number | null }>;
}

/**
 * Re-exported from its home in `reader-context.ts`, where it sits beside the
 * other "this reader's identity is broken" failure. Kept exported here because
 * this module is where the review surface's callers already reach for it; the
 * throw sites below are the review surface's, and `lib/brain/search.ts` raises
 * the same class from its own.
 */
export { BrainReaderUnresolvedError };

/** Surface tag carried on this module's `BrainReaderUnresolvedError` throws. */
const REVIEW_SURFACE = "review";

/**
 * Longest episode body served inline.
 *
 * Chat episodes are stored by value and are normally short, but nothing at rest
 * bounds them and a review queue renders many at once. Clipping is reported via
 * `bodyTruncated` rather than done silently — a reviewer judging evidence has to
 * know they are looking at a prefix.
 */
export const EPISODE_BODY_MAX_CHARS = 4_000;

/**
 * Most `in-tension-with` EDGES resolved per page.
 *
 * A real bound, not a theoretical one. `reconcile.ts`'s `TENSION_EDGE_CAP`
 * limits only the edges written OUT of a newly-created fact; edges written AT
 * an incumbent by later rivals are unbounded, and this query matches both
 * directions. Counterparts can exceed the cap too — an edge with both ends on
 * the page yields two views.
 *
 * When it bites, the page reports `tensionsTruncated` on the wire AND logs.
 * Neither half is optional: a truncated contradiction list renders as "nothing
 * further conflicts with this claim", which is the one thing this surface must
 * never imply. The truncation is also BIASED — edges are taken in
 * `(from_fact_id, to_fact_id)` order, so loss concentrates at the tail rather
 * than spreading evenly, and a candidate can lose every hint it originated
 * while keeping the ones pointed at it. Either way an incomplete list is
 * indistinguishable from a complete one, which is what the flag is for.
 *
 * Deliberately larger than the search surface's cap (200) — this budget serves
 * a 200-row admin table, that one an LLM context window. Both feed the shared
 * `loadTensionClusters` (`lib/brain/tensions.ts`).
 */
export const TENSION_FANOUT_CAP = 500;

/** Largest page this read model will serve. */
export const CANDIDATE_PAGE_MAX = 200;

/**
 * Query-only status selector, derived from the shared wire vocabulary rather
 * than restated — a second list here is how a `?status=` the UI can produce and
 * the route rejects gets shipped.
 */
export type CandidateStatusFilter = BrainFactStatusFilter;

export interface LoadCandidatesOptions {
  readonly ctx: BrainPrincipalContext;
  /** Defaults to `draft` — the review queue. */
  readonly status?: CandidateStatusFilter;
  /** Only candidates whose entity resolution was provisional. */
  readonly provisionalOnly?: boolean;
  /** Only candidates carrying at least one `in-tension-with` edge. */
  readonly inTensionOnly?: boolean;
  /** Case-insensitive substring match across subject, predicate, and object. */
  readonly search?: string;
  readonly limit: number;
  readonly offset: number;
  readonly requestId?: string;
}

// ---------------------------------------------------------------------------
// Provenance projection
// ---------------------------------------------------------------------------

/**
 * Keys `BrainFactProvenance` promises are always written AND always non-empty
 * strings.
 */
const REQUIRED_PROVENANCE_KEYS = [
  "source",
  "sourceId",
  "episodeId",
  "producer",
  "reconciledAt",
] as const;

/**
 * Structurally required but legitimately `null` — a source may have no author,
 * and an authored claim has no extraction pass. Checked for PRESENCE only, so a
 * payload that dropped the key entirely is still reported as incomplete rather
 * than rendering an unexplained blank.
 */
const NULLABLE_PROVENANCE_KEYS = ["actor", "occurredAt", "extractedAt"] as const;

/** ISO-8601 provenance keys. A value that will not parse is drift, not data. */
const TIMESTAMP_PROVENANCE_KEYS = ["occurredAt", "extractedAt", "reconciledAt"] as const;

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function isEntityRole(value: unknown): value is BrainEntityRole {
  return value === "subject" || value === "object";
}

function isParsableTimestamp(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== "string") return false;
  return !Number.isNaN(new Date(value).getTime());
}

/**
 * Narrow `brain_facts.provenance` (a `jsonb` column, so `unknown` in practice)
 * into the flat view the wire carries.
 *
 * Every field degrades to `null` independently, and `payloadComplete` reports
 * whether the structural keys `BrainFactProvenance` promises were all present,
 * well-typed, parseable (the three timestamps), and — when the caller passes
 * `expectedEpisodeId` — pointing at the same episode the FK does. That flag is the
 * whole point: the column has one writer and a NAMED shape but nothing at rest
 * enforcing it, so a renamed key or an `occurredAt: "yesterday"` would
 * otherwise surface as a silently blank field in a reviewer's UI — which reads
 * as "the producer recorded nothing" rather than "Atlas lost track of it".
 *
 * ## `attribution` — the one argument that is an ACL decision (#4836)
 *
 * `"withhold"` replaces the `sourceId` / `actor` / `occurredAt` triple with the
 * `visible: false` variant, which structurally cannot carry them. The decision
 * itself is NOT made here — this function still has no reader context, by
 * design; `attributionDecision` (`lib/brain/attribution.ts`) makes it from the
 * row's `pre_widening_visible_to` and the reader's principals, and this is
 * where it lands.
 *
 * REQUIRED, with no default, and that is the safety property. A defaulted
 * parameter would make every future call site disclose by omission — including
 * one added to a surface nobody thought of — so the compiler is what forces a
 * new read path to answer the question. Four call sites today: the review
 * queue and `searchBrain`, each for its own rows and for its tension
 * counterparts (#4913).
 *
 * Withholding never touches `payloadComplete`, which is computed over the
 * stored payload and reports data integrity, not entitlement. Both appear on
 * the wire and they mean different things.
 */
export function projectProvenance(
  value: unknown,
  expectedEpisodeId: string | null | undefined,
  attribution: BrainAttributionDecision,
): BrainFactProvenanceView {
  // The attribution the unparseable-payload arm below returns, and the value
  // the ordinary arm falls back to. Computed once, from a decision that does
  // not depend on the payload, so the two arms cannot disagree about
  // entitlement — on `disclose` it is all-null, which is exactly what a
  // payload we could not read has to say.
  //
  // Tested against "disclose", not against "withhold", and that polarity is
  // the safety property: if `BrainAttributionDecision` ever grows a third arm
  // (an audit-override arm is the obvious candidate — see `attribution.ts`),
  // this takes the WITHHELD branch until somebody deliberately handles it,
  // instead of silently disclosing to it.
  const fallbackAttribution: BrainFactAttributionView =
    attribution === "disclose"
      ? { visible: true, sourceId: null, actor: null, occurredAt: null }
      : { visible: false };

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      source: null,
      episodeId: null,
      producer: null,
      attribution: fallbackAttribution,
      extractedAt: null,
      reconciledAt: null,
      provisional: false,
      unresolved: [],
      payloadComplete: false,
    };
  }

  const p = value as Record<string, unknown>;
  // `episodeId` is the payload's copy of `source_episode_id`, which is the
  // column the FK actually enforces. Nothing reconciles the two, so without
  // this check the jsonb copy's only capability would be to disagree — and a
  // disagreement means the reconcile stage and the FK name different evidence
  // for the same claim, on the surface whose entire job is the provenance
  // chain. Only checked when the caller has the column to compare against.
  const episodeIdAgrees =
    expectedEpisodeId === undefined || expectedEpisodeId === null || p.episodeId === expectedEpisodeId;

  const payloadComplete =
    REQUIRED_PROVENANCE_KEYS.every((key) => typeof p[key] === "string" && p[key] !== "") &&
    NULLABLE_PROVENANCE_KEYS.every(
      (key) => key in p && (typeof p[key] === "string" || p[key] === null),
    ) &&
    TIMESTAMP_PROVENANCE_KEYS.every((key) => isParsableTimestamp(p[key])) &&
    episodeIdAgrees;

  const unresolved = Array.isArray(p.unresolved) ? p.unresolved.filter(isEntityRole) : [];

  // Presence gates it, but an explicitly-stored `false` is still honoured:
  // `provisional` is written only when true, so `"provisional" in p` is the
  // real signal, and `!== false` keeps a producer that started writing the flag
  // explicitly from being reported as provisional. OR-ed with the side-list so
  // a payload carrying `unresolved` without the flag cannot present as
  // "resolved, but here are the unresolved sides".
  //
  // NOTE the deliberate asymmetry with `PROVISIONAL_PREDICATE`, which is
  // presence-only and therefore WIDER: a stored `false` matches the filter but
  // projects as not-provisional. The filter is the wider of the two on purpose
  // — it never hides a row the reviewer asked to see.
  const provisional = ("provisional" in p && p.provisional !== false) || unresolved.length > 0;

  return {
    source: asString(p.source),
    episodeId: asString(p.episodeId),
    producer: asString(p.producer),
    attribution:
      attribution === "disclose"
        ? {
            visible: true,
            sourceId: asString(p.sourceId),
            actor: asString(p.actor),
            occurredAt: asString(p.occurredAt),
          }
        : fallbackAttribution,
    extractedAt: asString(p.extractedAt),
    reconciledAt: asString(p.reconciledAt),
    provisional,
    unresolved,
    payloadComplete,
  };
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/**
 * Corroboration = DISTINCT `provenance` edges (fact → episode), never a row
 * count. Re-observing a claim strengthens it by adding an edge; it never
 * duplicates the fact, so counting rows would report 1 forever.
 */
const CORROBORATION_SELECT = `(
    SELECT COUNT(DISTINCT ed.to_episode_id)
      FROM brain_edges ed
     WHERE ed.workspace_id = f.workspace_id
       AND ed.edge_type = 'provenance'
       AND ed.from_fact_id = f.id
  )::int`;

/**
 * "Is this candidate provisional?" — as SQL.
 *
 * Mirrors `projectProvenance`'s derivation exactly, and that is the point.
 * `provisional` is written only when true, so key presence is the primary
 * signal; but the projection also treats a non-empty `unresolved` as
 * provisional, so a payload carrying the side-list without the flag cannot
 * present as "resolved, but here are the unresolved sides". If the filter kept
 * only the `jsonb_exists` half, such a row would render the Provisional badge
 * and the amber alert while being EXCLUDED from the "Provisional only" queue
 * and from `provisionalTotal` — the same word meaning two things on one screen,
 * with the quality queue hiding exactly the rows most likely to be corrupt.
 *
 * `reconcile.ts` writes both keys or neither, so the divergence is not
 * producible in-region; a region-import bundle is the reachable path, which is
 * the drift class the projection's OR was added for in the first place.
 *
 * Exported for #4825's oversight aggregate, which reports the same "provisional"
 * word to the same admin on the same page. A second spelling there would be two
 * quality queues disagreeing about their own size — the exact failure the note
 * above describes, one surface further out. Both alias the fact table `f`.
 */
export const PROVISIONAL_PREDICATE = `(
    jsonb_exists(f.provenance, 'provisional')
    OR jsonb_array_length(COALESCE(f.provenance -> 'unresolved', '[]'::jsonb)) > 0
  )`;

/**
 * Does this fact carry an advisory contradiction hint, in EITHER direction?
 *
 * Both directions matter: `reconcile.ts` writes the edge from the NEW fact to
 * the incumbent, so an incumbent that has since been contradicted only ever
 * appears on the `to` side. Filtering on `from_fact_id` alone would hide from
 * the reviewer exactly the older claim whose trust is now in question.
 *
 * Exported alongside {@link PROVISIONAL_PREDICATE} and for the same reason —
 * #4825's oversight aggregate reports "in tension" beside this queue's own
 * count. Aliases the fact table `f`.
 */
export const TENSION_EXISTS_SELECT = `EXISTS (
    SELECT 1 FROM brain_edges te
     WHERE te.workspace_id = f.workspace_id
       AND te.edge_type = 'in-tension-with'
       AND (te.from_fact_id = f.id OR te.to_fact_id = f.id)
  )`;

const CANDIDATE_COLUMNS = `f.id::text AS id,
         f.subject,
         f.predicate,
         f.object,
         f.status,
         f.predicate_cardinality,
         f.visible_to,
         f.pre_widening_visible_to,
         f.provenance,
         f.source_episode_id::text AS source_episode_id,
         f.valid_from,
         f.valid_to,
         f.invalidated_at,
         f.extracted_at,
         f.ingested_at,
         f.updated_at`;

/**
 * Episodes by id, gated by the EPISODE's own visibility predicate.
 *
 * Deliberately not a join off the fact query. See the module header.
 */
function episodeSql(aclSql: string, idsParam: number): string {
  return `SELECT e.id::text AS id,
                e.source,
                e.source_id,
                e.source_actor,
                e.body,
                e.locator,
                e.occurred_at,
                e.ingested_at,
                e.visible_to
           FROM brain_episodes e
          WHERE ${aclSql}
            AND e.id = ANY($${idsParam}::uuid[])`;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

interface FactRow {
  readonly id: string;
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly status: string;
  readonly predicate_cardinality: string;
  readonly visible_to: unknown;
  /** ACL input for provenance attribution — see `AttributionRow` (#4836). */
  readonly pre_widening_visible_to: unknown;
  readonly provenance: unknown;
  readonly source_episode_id: string | null;
  readonly valid_from: unknown;
  readonly valid_to: unknown;
  readonly invalidated_at: unknown;
  readonly extracted_at: unknown;
  readonly ingested_at: unknown;
  readonly updated_at: unknown;
  readonly corroboration_count: unknown;
  /**
   * Newest corroborating observation ({@link LAST_OBSERVED_AT_SELECT}).
   * Optional because the tension-counterpart query reuses this row shape
   * without selecting it — counterparts carry no decay view.
   */
  readonly last_observed_at?: unknown;
  readonly total_count?: unknown;
}

/**
 * Timestamp → ISO-8601, or `null` when it will not parse.
 *
 * Never throws. `new Date(junk).toISOString()` raises `RangeError`, which on
 * this path would fail the whole page rather than blank one field — the wrong
 * trade for a value the reviewer is not making the trust call on. Every wire
 * timestamp is nullable for the same reason: a fabricated 1970 renders as "56
 * years ago" with the confidence of a real reading.
 */
function iso(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string" && value !== "") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function count(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

/**
 * Fact status off `pg`.
 *
 * `chk_brain_facts_status` makes an out-of-vocabulary value unreachable from
 * the database, so a fallback here is query drift, not tenant data — and it is
 * LOGGED, because a silent coercion in a module whose whole thesis is that
 * degradation must be visible would be the one place it wasn't. `draft` is the
 * conservative arm: an unknown status must never present as reviewed.
 *
 * Narrowed against the WIRE vocabulary (`BRAIN_FACT_REVIEW_STATUSES`), not the
 * API-side `BRAIN_FACT_STATUSES`, and via a type guard rather than two casts.
 * The schemas tuple is pinned exhaustive against the wire union, so this is the
 * one list a new status has to join; casting from the API tuple instead would
 * put an unrecognised value straight onto the wire, where it surfaces as a 500
 * from `checked()` on every page containing such a row.
 */
function isReviewStatus(value: unknown): value is BrainFactReviewStatus {
  return (BRAIN_FACT_REVIEW_STATUSES as readonly string[]).includes(value as string);
}

function reviewStatus(value: unknown, rowId: string, workspaceId: string): BrainFactReviewStatus {
  if (isReviewStatus(value)) return value;
  log.warn(
    { rowId, workspaceId, status: value },
    "brain review: fact carries a status outside the vocabulary — reporting it as a draft",
  );
  return "draft";
}

/**
 * Predicate cardinality off `pg`.
 *
 * Logged on drift for the same reason `reviewStatus` is, and it matters MORE
 * here: the fallback arm is the less conservative reading. `multi` renders as
 * "many values may coexist", understating a conflict, where `single` is the
 * cautious one. `chk_brain_facts_predicate_cardinality` puts this on the same
 * footing as the status CHECK — unreachable from the database, so a hit is
 * query drift.
 */
function predicateCardinality(row: FactRow, workspaceId: string): "single" | "multi" {
  if (row.predicate_cardinality === "single" || row.predicate_cardinality === "multi") {
    return row.predicate_cardinality;
  }
  log.warn(
    { rowId: row.id, workspaceId, cardinality: row.predicate_cardinality },
    "brain review: fact carries a predicate cardinality outside the vocabulary — reporting it as `multi`, which understates any conflict",
  );
  return "multi";
}

/**
 * Grant array off `pg`, with a flag saying whether it decoded at all.
 *
 * `visible_to text[] NOT NULL`, so a non-array is query drift — a driver that
 * stopped decoding `text[]`, a `SELECT` rewrite, a plugin type parser. Reported
 * rather than quietly coerced: an empty grant list renders as "visible to
 * nobody", which a reviewer would read as harmless when the claim may in fact
 * be org-wide.
 */
function grantTokens(
  value: unknown,
  meta: { rowId: string; workspaceId: string; requestId?: string },
): { tokens: readonly unknown[]; readable: boolean } {
  if (Array.isArray(value)) return { tokens: value, readable: true };
  log.warn(
    { ...meta, actualType: typeof value },
    "brain review: `visible_to` did not decode as an array — the grant cannot be shown, and this is an Atlas bug rather than bad tenant data",
  );
  return { tokens: [], readable: false };
}

/**
 * Map `parseGrant`'s malformed TOKENS back onto positions in `visible_to`.
 *
 * Positional, not by value, because `parseGrant` normalizes every non-string
 * element to `""` while the wire renders that same element as `String(t)` — so
 * a stored `NULL` arrives on the wire as the plausible-looking token `null`
 * that a value-match would fail to flag. Migration 0180's CHECK admits a `NULL`
 * element alongside a usable one, so this is reachable tenant data, and an
 * unhighlighted `null` badge beneath the sentence "highlighted tokens grant
 * nobody access" is exactly the wrong answer.
 *
 * `parseGrant` walks the input in order and reports one entry per malformed
 * element, so stepping the two together is well-defined.
 */
function malformedIndices(
  tokens: readonly unknown[],
  malformed: readonly string[],
  meta: { rowId: string; workspaceId: string; requestId?: string },
): number[] {
  if (malformed.length === 0) return [];
  const indices: number[] = [];
  let cursor = 0;
  for (let i = 0; i < tokens.length && cursor < malformed.length; i++) {
    const token = tokens[i];
    const asMalformed = typeof token === "string" ? token : "";
    if (asMalformed === malformed[cursor]) {
      indices.push(i);
      cursor++;
    }
  }
  if (indices.length !== malformed.length) {
    // Unreachable under `parseGrant`'s current contract, which is exactly why
    // it is worth a tripwire: if that contract ever changes (trimming,
    // lowercasing, deduping before reporting), the walk stalls and the UI
    // renders an UNHIGHLIGHTED junk token directly beneath the sentence saying
    // highlighted tokens grant nobody access.
    log.warn(
      { ...meta, reported: malformed.length, located: indices.length },
      "brain review: could not map every malformed grant token to a position — some junk tokens will render unhighlighted; `parseGrant`'s ordering contract changed",
    );
  }
  return indices;
}

/**
 * The publish endpoint's own verdict, computed on read.
 *
 * Shares `classifyFactForPromotion` with `promoteBrainFacts` rather than
 * restating the rules, so the queue can never advertise a promotable claim the
 * transaction then refuses.
 */
function promotionBlock(row: FactRow): BrainFactPromotionBlock | null {
  const draftRow: DraftFactRow = {
    id: row.id,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    source_episode_id: row.source_episode_id,
    provenance: row.provenance,
    visible_to: row.visible_to,
  };
  const refusal = classifyFactForPromotion(draftRow);
  return refusal ? { reasons: [...refusal.reasons], detail: refusal.detail } : null;
}

/** The candidate query's WHERE clauses + bound params — shared by page and count. */
function candidateWhere(
  options: LoadCandidatesOptions,
  aclSql: string,
  aclParams: readonly unknown[],
): { where: string[]; params: unknown[] } {
  const params: unknown[] = [...aclParams];
  const where: string[] = [
    aclSql,
    "f.invalidated_at IS NULL",
    // The supersession axis (#4912): a fact whose `valid_to` has passed was
    // replaced at the publish gate and leaves the review surface exactly as a
    // tombstoned one does — there is no trust call left to make on it, and the
    // as-of reads M2 adds are where it stays readable.
    brainFactCurrentClause("f"),
  ];

  const status = options.status ?? "draft";
  if (status !== "all") {
    params.push(status);
    where.push(`f.status = $${params.length}`);
  }
  if (options.provisionalOnly) {
    where.push(PROVISIONAL_PREDICATE);
  }
  if (options.inTensionOnly) {
    where.push(TENSION_EXISTS_SELECT);
  }
  const search = options.search?.trim();
  if (search) {
    // `%` and `_` are LIKE metacharacters; escaping them keeps a literal
    // underscore in an entity name from silently matching any character.
    const escaped = search.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    params.push(`%${escaped}%`);
    const p = `$${params.length}`;
    where.push(`(f.subject ILIKE ${p} OR f.predicate ILIKE ${p} OR f.object ILIKE ${p})`);
  }

  return { where, params };
}

/**
 * One page of reviewable candidates, fully formed.
 *
 * Runs at most four statements on a populated page regardless of page size —
 * the facts, their episodes, the tension edges, the tension counterparts
 * (skipped when no edges matched) — and at most two
 * on an empty one (the facts, plus a total re-count only when the page could be
 * past the end). Nothing is fetched per row: ADR-0036 names review-gate
 * throughput a first-class concern, and a per-row round trip is what makes a
 * queue unusable at connector scale.
 *
 * @throws {BrainReaderUnresolvedError} when the reader has no usable principals.
 */
export async function loadFactCandidates(
  db: BrainCandidateReader,
  options: LoadCandidatesOptions,
): Promise<BrainFactCandidateListResponse> {
  const { ctx, requestId } = options;
  const limit = Math.min(Math.max(1, Math.trunc(options.limit)), CANDIDATE_PAGE_MAX);
  const offset = Math.max(0, Math.trunc(options.offset));

  const acl = aclVisibilityClause(ctx, {
    table: "brain_facts",
    alias: "f",
    paramIndex: 1,
    requestId,
  });
  if (acl.decision === "deny-all") {
    throw new BrainReaderUnresolvedError(ctx.workspaceId, ctx.origin, REVIEW_SURFACE);
  }

  const { where, params } = candidateWhere(options, acl.sql, acl.params);

  params.push(limit, offset);
  const limitParam = params.length - 1;

  // `COUNT(*) OVER ()` yields the grand total in the same pass as the page —
  // one statement instead of a second COUNT that could disagree with it under
  // concurrent ingest.
  //
  // ORDER BY: the stale-first term is #4914's SURFACING HINT — a boolean, so
  // genuinely stale claims float to the top while everything else keeps the
  // newest-ingest-first order reviewers already know. It is deliberately a
  // two-bucket hint and not a decay SORT: ordering the whole queue by age
  // would be a ranking, and the hint's only job is to keep an aged claim from
  // being buried under fresh ingest. It filters nothing and writes nothing.
  // The per-row subquery runs
  // over every row matching WHERE (ORDER BY sits under the LIMIT) — an
  // accepted cost, kept honest by the fan-out already spent on
  // `CORROBORATION_SELECT`. The hint and the label share their threshold
  // constant, so the WHAT of "stale" cannot drift — but the WHEN runs on two
  // clocks (Postgres `now()` here, `new Date()` in the projection), so a row
  // sitting exactly at the boundary can float while labelling "Aging", or
  // label "Stale" without floating, by at most the skew plus the label's
  // floor-rounding. Advisory on both sides and self-healing on the next
  // read; noted so nobody reads "shared constant" as "bit-identical verdict".
  const sql = `SELECT ${CANDIDATE_COLUMNS},
         ${CORROBORATION_SELECT} AS corroboration_count,
         ${LAST_OBSERVED_AT_SELECT} AS last_observed_at,
         COUNT(*) OVER ()::int AS total_count
    FROM brain_facts f
   WHERE ${where.join("\n     AND ")}
   ORDER BY ${STALE_SURFACING_HINT_SQL} DESC, f.ingested_at DESC, f.id DESC
   LIMIT $${limitParam} OFFSET $${limitParam + 1}`;

  const result = await db.query(sql, params);
  const rows = result.rows as FactRow[];

  if (rows.length === 0) {
    // An empty WINDOW produces no `COUNT(*) OVER ()` row, so the total is
    // UNKNOWN rather than zero. Asserting 0 would collapse the client's
    // `pageCount` to 1 and render "nothing to review" over a queue merely paged
    // past its end — with the stats bar directly above it saying otherwise.
    // Only pay for the extra statement when the page could be past the end.
    const total = offset > 0 ? await countCandidates(db, options, acl.sql, acl.params) : 0;
    return { candidates: [], total, tensionsTruncated: false };
  }

  const total = count(rows[0]?.total_count);

  // Another observation point for the PARTIALLY-malformed half of
  // `logGrantAnomalies`'s remit. It does NOT touch #4797, whose gap is the
  // ENTIRELY-malformed grant: that matches no reader token, so such a row never
  // comes back from this ACL-gated SELECT and goes unlogged here too. What it
  // adds over `reconcile.ts` (at ingest, on the episode grant a fact inherits)
  // and `promoteBrainFacts` (only for drafts it classifies as promotable) is
  // the rows that never reach promotion at all — rejected at review, or
  // arriving already `published` through a region import.
  //
  // The RETURN VALUE is what feeds `malformedGrantIndices` below. Re-deriving
  // the token classes here would fork `parseGrant`'s grammar, which `acl.ts` is
  // explicitly the single source of truth for; calling `logGrantAnomalies`
  // twice would double every warning line. Keeping the one parse does neither.
  const grants = new Map<
    string,
    { tokens: readonly unknown[]; readable: boolean; malformed: number[] }
  >();
  for (const row of rows) {
    const { tokens, readable } = grantTokens(row.visible_to, {
      rowId: row.id,
      workspaceId: ctx.workspaceId,
      requestId,
    });
    const parsed = logGrantAnomalies(tokens, {
      table: "brain_facts",
      rowId: row.id,
      workspaceId: ctx.workspaceId,
      requestId,
    });
    grants.set(row.id, {
      tokens,
      readable,
      malformed: malformedIndices(tokens, parsed.malformed, {
        rowId: row.id,
        workspaceId: ctx.workspaceId,
        requestId,
      }),
    });
  }

  const [episodes, tensions] = await Promise.all([
    loadEpisodes(db, rows, ctx, requestId),
    loadTensions(db, rows, ctx, requestId),
  ]);

  const candidates = rows.map((row): BrainFactCandidate => {
    const grant = grants.get(row.id);
    // `FactRow` structurally satisfies `AttributionRow`, so the column is
    // INTERPRETED once, in the module that owns the decision — then handed to
    // BOTH consumers of it, so provenance and decay cannot disagree about the
    // reader's entitlement. Each surface still names the column in its own
    // SELECT, which is what the `undefined` arm of `attributionDecision`
    // exists to catch.
    const attribution = attributionDecision(row, ctx, requestId);
    if (row.last_observed_at === undefined) {
      // `pg` never yields `undefined` for a selected column, so the page
      // query stopped selecting the decay anchor — query drift, and the
      // classifier will report "age unknown" rather than fabricating a label
      // from ingest recency. Logged HERE because the pure module has no row
      // id; same posture as `attributionDecision`'s missing-column arm.
      log.warn(
        { rowId: row.id, workspaceId: ctx.workspaceId, requestId },
        "brain review: `last_observed_at` absent from the row — the queue query no longer selects the decay anchor; reporting age unknown",
      );
    }
    return {
      id: row.id,
      subject: row.subject,
      predicate: row.predicate,
      object: row.object,
      status: reviewStatus(row.status, row.id, ctx.workspaceId),
      predicateCardinality: predicateCardinality(row, ctx.workspaceId),
      visibleTo: (grant?.tokens ?? []).map((t) => (typeof t === "string" ? t : String(t))),
      malformedGrantIndices: grant?.malformed ?? [],
      grantReadable: grant?.readable ?? false,
      corroborationCount: count(row.corroboration_count),
      provenance: projectProvenance(row.provenance, row.source_episode_id, attribution),
      // Read-time and advisory — the signal exists on the wire and nowhere
      // else. Same attribution decision as the provenance above, because for a
      // singly-corroborated fact the observation IS the withheld `occurredAt`.
      decay: computeDecaySignal(
        {
          lastObservedAt: row.last_observed_at,
          validFrom: row.valid_from,
          ingestedAt: row.ingested_at,
        },
        attribution,
      ),
      // `source_episode_id uuid NOT NULL` + the composite FK make the `null`
      // arm unreachable from the database, so it is defense in depth. The FK's
      // ON DELETE RESTRICT is also what keeps `withheldEpisode` honest: a
      // missing episode cannot be reported as "being withheld from you",
      // because a fact's episode cannot go missing.
      episode: row.source_episode_id
        ? (episodes.get(row.source_episode_id) ?? withheldEpisode(row.source_episode_id))
        : null,
      tensions: tensions.views.get(row.id) ?? [],
      promotionBlock: promotionBlock(row),
      validFrom: iso(row.valid_from),
      validTo: iso(row.valid_to),
      extractedAt: iso(row.extracted_at),
      ingestedAt: iso(row.ingested_at),
      updatedAt: iso(row.updated_at),
    };
  });

  return { candidates, total, tensionsTruncated: tensions.truncated };
}

/** Grand total when the page itself came back empty. */
async function countCandidates(
  db: BrainCandidateReader,
  options: LoadCandidatesOptions,
  aclSql: string,
  aclParams: readonly unknown[],
): Promise<number> {
  const { where, params } = candidateWhere(options, aclSql, aclParams);
  const result = await db.query(
    `SELECT COUNT(*)::int AS n FROM brain_facts f WHERE ${where.join("\n     AND ")}`,
    params,
  );
  return count((result.rows[0] as Record<string, unknown> | undefined)?.n);
}

/** The evidence exists but this reader is not entitled to it. */
function withheldEpisode(id: string): BrainFactEpisodeView {
  return { visible: false, id };
}

async function loadEpisodes(
  db: BrainCandidateReader,
  rows: readonly FactRow[],
  ctx: BrainPrincipalContext,
  requestId: string | undefined,
): Promise<Map<string, BrainFactEpisodeView>> {
  const ids = [...new Set(rows.map((r) => r.source_episode_id).filter((id): id is string => !!id))];
  const out = new Map<string, BrainFactEpisodeView>();
  if (ids.length === 0) return out;

  // A FRESH clause against `brain_episodes` — the fact's decision does not
  // carry over, and re-deriving it here is what keeps a fact's grant from
  // standing in for its evidence's.
  const acl = aclVisibilityClause(ctx, {
    table: "brain_episodes",
    alias: "e",
    paramIndex: 1,
    requestId,
  });
  if (acl.decision === "deny-all") {
    // Unreachable — the caller already threw on the same decision against
    // `brain_facts`, and both arms derive from the same principal set. Kept
    // because that reasoning is about the CALLER, not about this function.
    throw new BrainReaderUnresolvedError(ctx.workspaceId, ctx.origin, REVIEW_SURFACE);
  }

  const params: unknown[] = [...acl.params, ids];
  const result = await db.query(episodeSql(acl.sql, params.length), params);

  for (const raw of result.rows) {
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : null;
    if (!id) continue;
    const { tokens } = grantTokens(r.visible_to, {
      rowId: id,
      workspaceId: ctx.workspaceId,
      requestId,
    });
    logGrantAnomalies(tokens, {
      table: "brain_episodes",
      rowId: id,
      workspaceId: ctx.workspaceId,
      requestId,
    });
    const body = typeof r.body === "string" ? r.body : null;
    const truncated = body !== null && body.length > EPISODE_BODY_MAX_CHARS;
    out.set(id, {
      visible: true,
      id,
      source: asString(r.source),
      sourceId: asString(r.source_id),
      sourceActor: asString(r.source_actor),
      body: truncated ? body.slice(0, EPISODE_BODY_MAX_CHARS) : body,
      bodyTruncated: truncated,
      locator: asString(r.locator),
      occurredAt: iso(r.occurred_at),
      ingestedAt: iso(r.ingested_at),
    });
  }
  return out;
}

/**
 * Advisory contradiction hints for a page of candidates.
 *
 * The walk itself — edges, then counterpart facts through a FRESH fact
 * predicate, never a join onto the owner row — is `loadTensionClusters`
 * (`lib/brain/tensions.ts`, shared with `searchBrain` since #4913). What stays
 * here is the REVIEW projection: a human resolves conflicts rival by rival, so
 * a counterpart the reader may not see is reported as a per-rival
 * `visible: false` handle rather than the search surface's aggregated count.
 * Omitting it would read as "no conflicts" — precisely the signal that should
 * stop a reviewer approving.
 *
 * Never ranked, never ordered by recency or status — see `BrainFactTensionView`.
 */
async function loadTensions(
  db: BrainCandidateReader,
  rows: readonly FactRow[],
  ctx: BrainPrincipalContext,
  requestId: string | undefined,
): Promise<{ views: Map<string, BrainFactTensionView[]>; truncated: boolean }> {
  const { clusters, truncated } = await loadTensionClusters(
    db,
    rows.map((r) => r.id),
    { ctx, cap: TENSION_FANOUT_CAP, surface: REVIEW_SURFACE, log, requestId },
  );

  const out = new Map<string, BrainFactTensionView[]>();
  for (const [owner, cluster] of clusters) {
    const views: BrainFactTensionView[] = cluster.counterparts.map(({ row, direction }) => ({
      visible: true,
      factId: row.id,
      edgeDirection: direction,
      subject: row.subject,
      predicate: row.predicate,
      object: row.object,
      status: reviewStatus(row.status, row.id, ctx.workspaceId),
      validFrom: iso(row.valid_from),
      ingestedAt: iso(row.ingested_at),
      invalidatedAt: iso(row.invalidated_at),
      corroborationCount: count(row.corroboration_count),
      // Decided per COUNTERPART, off its own row. A tension counterpart is
      // a fact in its own right and was fetched through its own ACL
      // predicate, so inheriting the owner's decision would be a guess
      // about a different row's grant.
      provenance: projectProvenance(
        row.provenance,
        row.source_episode_id,
        attributionDecision(row, ctx, requestId),
      ),
    }));
    for (const w of cluster.withheld) {
      views.push({ visible: false, factId: w.factId, edgeDirection: w.direction });
    }
    // Deterministic, and deliberately NOT by time, status, or corroboration —
    // any of those would be a ranking, and refusing to arbitrate is the point.
    // (The cluster's two lists arrive individually sorted; re-sorting the
    // merged list keeps visible and withheld rivals interleaved by id, as the
    // review surface has always rendered them.)
    views.sort((a, b) => a.factId.localeCompare(b.factId));
    out.set(owner, views);
  }

  return { views: out, truncated };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/**
 * Queue vitals for the stats bar, scoped to this reader's grants.
 *
 * `draftTotal` can legitimately be SMALLER than `/api/v1/mode`
 * `draftCounts.brainFacts`, which counts every draft in the workspace
 * regardless of who is looking. Both are correct: the mode chip answers "does
 * this workspace have unpublished work", this answers "how much of it can I
 * review".
 *
 * @throws {BrainReaderUnresolvedError} when the reader has no usable principals.
 */
export async function loadFactCandidateSummary(
  db: BrainCandidateReader,
  ctx: BrainPrincipalContext,
  requestId?: string,
): Promise<BrainFactCandidateSummary> {
  const acl = aclVisibilityClause(ctx, {
    table: "brain_facts",
    alias: "f",
    paramIndex: 1,
    requestId,
  });
  if (acl.decision === "deny-all") {
    throw new BrainReaderUnresolvedError(ctx.workspaceId, ctx.origin, REVIEW_SURFACE);
  }

  const result = await db.query(
    `SELECT COUNT(*) FILTER (WHERE f.status = 'draft')::int AS draft_total,
            COUNT(*) FILTER (WHERE f.status = 'draft'
                               AND ${PROVISIONAL_PREDICATE})::int AS provisional_total,
            COUNT(*) FILTER (WHERE f.status = 'draft' AND ${TENSION_EXISTS_SELECT})::int AS in_tension_total,
            COUNT(*) FILTER (WHERE f.status = 'published')::int AS published_total
       FROM brain_facts f
      WHERE ${acl.sql}
        AND f.invalidated_at IS NULL
        AND ${brainFactCurrentClause("f")}`,
    [...acl.params],
  );

  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    // An aggregate with no GROUP BY always returns exactly one row, so this is
    // unreachable — and a silent "0 awaiting review" is precisely the reading
    // that would send a reviewer off to publish a backlog they never saw.
    throw new Error(
      "brain review: the queue-vitals aggregate returned no row — the summary query shape changed",
    );
  }
  return {
    draftTotal: count(row.draft_total),
    provisionalTotal: count(row.provisional_total),
    inTensionTotal: count(row.in_tension_total),
    publishedTotal: count(row.published_total),
  };
}

// ---------------------------------------------------------------------------
// Rejection
// ---------------------------------------------------------------------------
//
// Rejection is the `retract` CORRECTION verb, and it moved (#4915): the
// tombstone stamp, the correction-episode materialization, and the
// derives-from re-review flags all live in `lib/brain/correction.ts`
// (`correctFact({ verb: "retract" })`), which the admin route's
// `POST /:id/retract` now runs. This module deliberately keeps no retract
// spelling of its own — a second `invalidated_at` writer here would be exactly
// the two-retract-semantics split the unification removed.
