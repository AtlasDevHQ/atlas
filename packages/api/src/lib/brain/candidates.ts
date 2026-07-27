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
 * Rejection is {@link retractFactCandidate} — a tombstone on `invalidated_at`,
 * not a status write. See its own comment for why that is the archive verb.
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
 *     that has to grow a fourth clause.
 *
 * `invalidated_at IS NULL` is AND-ed on top and is NOT one of the four — it is
 * the tombstone axis, which `brainFactStatusClause` explicitly does not cover,
 * so every current-belief read has to add it itself.
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
import { classifyFactForPromotion, type DraftFactRow } from "@atlas/api/lib/brain/promotion";
import { BRAIN_FACT_REVIEW_STATUSES, type BrainFactStatusFilter } from "@useatlas/schemas";
import type {
  BrainEntityRole,
  BrainFactCandidate,
  BrainFactCandidateListResponse,
  BrainFactCandidateSummary,
  BrainFactEpisodeView,
  BrainFactPromotionBlock,
  BrainFactProvenanceView,
  BrainFactRetractResponse,
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
 */
export function projectProvenance(
  value: unknown,
  expectedEpisodeId?: string | null,
): BrainFactProvenanceView {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      source: null,
      sourceId: null,
      episodeId: null,
      actor: null,
      producer: null,
      occurredAt: null,
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
    sourceId: asString(p.sourceId),
    episodeId: asString(p.episodeId),
    actor: asString(p.actor),
    producer: asString(p.producer),
    occurredAt: asString(p.occurredAt),
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
  readonly provenance: unknown;
  readonly source_episode_id: string | null;
  readonly valid_from: unknown;
  readonly valid_to: unknown;
  readonly invalidated_at: unknown;
  readonly extracted_at: unknown;
  readonly ingested_at: unknown;
  readonly updated_at: unknown;
  readonly corroboration_count: unknown;
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
  const where: string[] = [aclSql, "f.invalidated_at IS NULL"];

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
 * Runs four statements on a populated page regardless of page size — the facts,
 * their episodes, the tension edges, the tension counterparts — and at most two
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
  const sql = `SELECT ${CANDIDATE_COLUMNS},
         ${CORROBORATION_SELECT} AS corroboration_count,
         COUNT(*) OVER ()::int AS total_count
    FROM brain_facts f
   WHERE ${where.join("\n     AND ")}
   ORDER BY f.ingested_at DESC, f.id DESC
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
      provenance: projectProvenance(row.provenance, row.source_episode_id),
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

interface TensionEdgeRow {
  readonly from_id: string | null;
  readonly to_id: string | null;
}

/**
 * Advisory contradiction hints for a page of candidates.
 *
 * Two statements: the edges (ungated — `brain_edges` carries no grant of its
 * own), then the counterpart FACTS through the fact predicate, applied
 * independently. A counterpart the reader may not see is reported as
 * `visible: false` rather than dropped: "this claim has a rival you cannot see"
 * is precisely the signal that should stop a reviewer approving it, and
 * omitting the row would read as "no conflicts".
 *
 * Never ranked, never ordered by recency or status — see `BrainFactTensionView`.
 */
async function loadTensions(
  db: BrainCandidateReader,
  rows: readonly FactRow[],
  ctx: BrainPrincipalContext,
  requestId: string | undefined,
): Promise<{ views: Map<string, BrainFactTensionView[]>; truncated: boolean }> {
  const out = new Map<string, BrainFactTensionView[]>();
  const pageIds = rows.map((r) => r.id);
  if (pageIds.length === 0) return { views: out, truncated: false };
  if (!ctx.workspaceId) {
    // Unreachable — a workspace-less context denies at the caller. Loud rather
    // than a bare `return`, because this guard's failure mode is a page that
    // silently reports no conflicts at all.
    log.warn(
      { requestId, origin: ctx.origin },
      "brain review: contradiction lookup reached with no workspace — reporting no conflicts, which is wrong; this is an Atlas bug",
    );
    return { views: out, truncated: false };
  }

  // `DISTINCT` because migration 0180 puts no unique index on
  // `(workspace_id, edge_type, from_fact_id, to_fact_id)` — `reconcile.ts`
  // dedupes with `WHERE NOT EXISTS`, which two concurrent passes can race. A
  // duplicate edge would otherwise render as two identical conflict cards and
  // an inflated "In tension (2)".
  const edgeResult = await db.query(
    `SELECT DISTINCT from_fact_id::text AS from_id, to_fact_id::text AS to_id
       FROM brain_edges
      WHERE workspace_id = $1
        AND edge_type = 'in-tension-with'
        AND (from_fact_id = ANY($2::uuid[]) OR to_fact_id = ANY($2::uuid[]))
      ORDER BY from_id, to_id
      LIMIT $3`,
    [ctx.workspaceId, pageIds, TENSION_FANOUT_CAP + 1],
  );
  const edges = edgeResult.rows as TensionEdgeRow[];
  if (edges.length === 0) return { views: out, truncated: false };

  // Never a silent cap. `tensionsTruncated` reaches the reviewer as well as the
  // log — see TENSION_FANOUT_CAP.
  const truncated = edges.length > TENSION_FANOUT_CAP;
  const usable = truncated ? edges.slice(0, TENSION_FANOUT_CAP) : edges;
  if (truncated) {
    log.warn(
      { workspaceId: ctx.workspaceId, requestId, cap: TENSION_FANOUT_CAP, pageSize: pageIds.length },
      "brain review: in-tension-with fan-out exceeded the per-page cap — some contradiction hints are not shown on this page",
    );
  }

  const onPage = new Set(pageIds);
  /** candidate id → [counterpart id, which end of the edge the counterpart sat on] */
  const pairs: Array<{
    readonly owner: string;
    readonly other: string;
    readonly direction: "from" | "to";
  }> = [];
  for (const edge of usable) {
    const { from_id: from, to_id: to } = edge;
    if (!from || !to) continue;
    // An edge whose BOTH ends are on this page yields two entries — each
    // candidate names the other. That is symmetric on purpose: neither end is
    // the authority over the other.
    if (onPage.has(from)) pairs.push({ owner: from, other: to, direction: "to" });
    if (onPage.has(to)) pairs.push({ owner: to, other: from, direction: "from" });
  }
  if (pairs.length === 0) return { views: out, truncated };

  const counterpartIds = [...new Set(pairs.map((p) => p.other))];
  const acl = aclVisibilityClause(ctx, {
    table: "brain_facts",
    alias: "f",
    paramIndex: 1,
    requestId,
  });

  if (acl.decision === "deny-all") {
    // Unreachable for the same reason as `loadEpisodes` — the caller already
    // threw on this decision, against the same table with the same context.
    // Throwing rather than skipping the query, because skipping leaves every
    // counterpart unresolved and therefore rendered as "a conflicting claim
    // you are not allowed to see" — fabricated ACL withholding, and the one
    // arm a reviewer cannot tell apart from the real thing.
    throw new BrainReaderUnresolvedError(ctx.workspaceId, ctx.origin, REVIEW_SURFACE);
  }

  const visible = new Map<string, FactRow>();
  {
    const params: unknown[] = [...acl.params, counterpartIds];
    // `invalidated_at` is NOT filtered here, unlike the queue itself: a rival
    // that was retracted is still why this claim was contested, and hiding it
    // would make a contradiction vanish the moment somebody rejected one side.
    // It IS selected and carried to the wire as `invalidatedAt`, because
    // retraction never writes `status` — so without it a withdrawn rival would
    // render as an indistinguishable live `draft`.
    const result = await db.query(
      `SELECT ${CANDIDATE_COLUMNS},
              ${CORROBORATION_SELECT} AS corroboration_count
         FROM brain_facts f
        WHERE ${acl.sql}
          AND f.id = ANY($${params.length}::uuid[])`,
      params,
    );
    for (const raw of result.rows as FactRow[]) visible.set(raw.id, raw);
  }

  for (const pair of pairs) {
    const row = visible.get(pair.other);
    const view: BrainFactTensionView = row
      ? {
          visible: true,
          factId: row.id,
          edgeDirection: pair.direction,
          subject: row.subject,
          predicate: row.predicate,
          object: row.object,
          status: reviewStatus(row.status, row.id, ctx.workspaceId),
          validFrom: iso(row.valid_from),
          ingestedAt: iso(row.ingested_at),
          invalidatedAt: iso(row.invalidated_at),
          corroborationCount: count(row.corroboration_count),
          provenance: projectProvenance(row.provenance, row.source_episode_id),
        }
      : { visible: false, factId: pair.other, edgeDirection: pair.direction };
    const list = out.get(pair.owner);
    if (list) list.push(view);
    else out.set(pair.owner, [view]);
  }

  // Deterministic, and deliberately NOT by time, status, or corroboration —
  // any of those would be a ranking, and refusing to arbitrate is the point.
  for (const list of out.values()) list.sort((a, b) => a.factId.localeCompare(b.factId));

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
        AND f.invalidated_at IS NULL`,
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

/**
 * Reject a candidate by RETRACTING it — the review gate's negative verb.
 *
 * ## Why this stamps `invalidated_at` and not `status`
 *
 * `brain_facts.status` has exactly one writer, the atomic publish endpoint, and
 * `scripts/check-brain-fact-promotion.sh` refuses every other status-writing
 * shape — including one that merely FILTERS on the column inside an UPDATE. A
 * "reject" that wrote `status = 'archived'` would be a second gate writer, and
 * the guard's own remediation text names the alternative: a fact is never
 * deleted and never demoted by status, so withdrawal is a tombstone
 * (ADR-0036 — supersession is not deletion).
 *
 * The tombstone does the queue work for free. `DRAFT_FACTS_SQL`,
 * `brainFactsCountSql`, the publish preview, and this module's own list all
 * exclude `invalidated_at IS NOT NULL`, so a retracted claim leaves the queue,
 * stops being counted in `draftCounts`, and is never re-offered for promotion —
 * while staying readable to an as-of query, which is exactly what ADR-0036 asks
 * of a withdrawn belief.
 *
 * ## Not restricted to drafts
 *
 * A published claim can also be wrong, and retracting one is the same
 * operation. Constraining this to drafts would need `status` in the statement,
 * which the guard refuses — and would be the wrong behaviour anyway.
 *
 * Returns `null` when nothing was updated: no such fact, already retracted, or
 * not visible to this reader. The three are deliberately indistinguishable —
 * telling a reader that a fact they cannot see exists is the leak the
 * predicate is there to prevent.
 *
 * @throws {BrainReaderUnresolvedError} when the reader has no usable principals.
 */
export async function retractFactCandidate(
  db: BrainCandidateReader,
  options: {
    readonly ctx: BrainPrincipalContext;
    readonly factId: string;
    readonly requestId?: string;
  },
): Promise<BrainFactRetractResponse | null> {
  const { ctx, factId, requestId } = options;

  const acl = aclVisibilityClause(ctx, {
    table: "brain_facts",
    alias: "f",
    paramIndex: 1,
    requestId,
  });
  if (acl.decision === "deny-all") {
    throw new BrainReaderUnresolvedError(ctx.workspaceId, ctx.origin, REVIEW_SURFACE);
  }

  const params: unknown[] = [...acl.params, factId];
  const result = await db.query(
    `UPDATE brain_facts AS f
        SET invalidated_at = now(), updated_at = now()
      WHERE ${acl.sql}
        AND f.id = $${params.length}::uuid
        AND f.invalidated_at IS NULL
    RETURNING f.id::text AS id, f.invalidated_at`,
    params,
  );

  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;

  const invalidatedAt = iso(row.invalidated_at);
  if (typeof row.id !== "string" || !invalidatedAt) {
    // `RETURNING` on an UPDATE that matched a row cannot produce this. If it
    // ever does, the write HAPPENED and reporting failure would send an admin
    // to retract again; throwing surfaces a 500 with a requestId instead.
    throw new Error(
      `retractFactCandidate: RETURNING gave an unusable row for fact ${factId} — the retraction committed but cannot be reported`,
    );
  }

  log.info(
    { workspaceId: ctx.workspaceId, factId, userId: ctx.userId, requestId },
    "brain review: fact candidate retracted — it leaves the review queue and is never offered for promotion",
  );

  return { id: row.id, invalidatedAt };
}
